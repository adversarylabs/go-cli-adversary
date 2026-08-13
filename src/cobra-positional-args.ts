import type { Node } from "web-tree-sitter";
import type { Signal, SourceRevision } from "./types.js";

const RULE_ID = "go-cli.cobra-positional-args-minimum";

/**
 * Find Cobra callbacks that index their positional args more deeply than the
 * command's validator or callback-local control flow proves safe.
 */
export function cobraPositionalArgsMinimumSignals(
  file: SourceRevision,
  root: Node | undefined,
): Signal[] {
  if (root === undefined) return [];
  const cobraAliases = importedCobraAliases(root);
  if (cobraAliases.size === 0) return [];
  const nonNilErrorConstructors = importedNonNilErrorConstructors(root);

  const declarations = new Map<string, Node>();
  for (const declaration of root.descendantsOfType("function_declaration")) {
    const name = declaration.childForFieldName("name")?.text;
    if (name !== undefined) declarations.set(name, declaration);
  }

  const signals: Signal[] = [];
  for (const literal of root.descendantsOfType("composite_literal")) {
    const type = literal.childForFieldName("type")?.text;
    if (type === undefined || ![...cobraAliases].some((alias) => type === `${alias}.Command`)) {
      continue;
    }
    const fields = keyedFields(literal);
    const callback = fields.get("RunE") ?? fields.get("Run");
    if (callback === undefined || callback.type !== "func_literal") continue;

    const argsName = positionalParameterName(callback);
    if (argsName === undefined) continue;
    const validator = fields.get("Args");
    const validatorMinimum = validator === undefined
      ? 0
      : minimumProvenByValidator(validator, declarations, cobraAliases, nonNilErrorConstructors);
    // An unknown custom validator may already enforce the contract. Do not
    // turn incomplete static knowledge into a high-confidence panic finding.
    if (validator !== undefined && validatorMinimum === undefined) continue;

    for (const access of positionalAccesses(callback, argsName)) {
      if (access.required <= (validatorMinimum ?? 0)) continue;
      if (minimumProvenAtAccess(access.node, callback, argsName) >= access.required) continue;
      const anchor = signalAnchor(file, access.node, validator);
      if (anchor === undefined) continue;
      signals.push({
        ruleId: RULE_ID,
        path: file.path,
        line: anchor.startPosition.row + 1,
        endLine: anchor.endPosition.row + 1,
        message:
          `${argsName} requires at least ${access.required} positional argument${access.required === 1 ? "" : "s"}, ` +
          `but this Cobra command only proves a minimum of ${validatorMinimum ?? 0}.`,
        snippet: anchor.text.trim().slice(0, 300),
        data: {
          requiredMinimum: access.required,
          validatorMinimum: validatorMinimum ?? 0,
          access: access.node.text,
          accessLine: access.node.startPosition.row + 1,
        },
      });
    }
  }
  return deduplicate(signals);
}

function signalAnchor(file: SourceRevision, access: Node, validator: Node | undefined): Node | undefined {
  if (file.status === "repository" || file.status === "added") return access;
  if (nodeTouchesChangedLine(access, file.changedLines)) return access;
  if (validator !== undefined && nodeTouchesChangedLine(validator, file.changedLines)) return validator;
  return undefined;
}

function nodeTouchesChangedLine(node: Node, changedLines: Set<number>): boolean {
  for (let line = node.startPosition.row + 1; line <= node.endPosition.row + 1; line += 1) {
    if (changedLines.has(line)) return true;
  }
  return false;
}

function importedCobraAliases(root: Node): Set<string> {
  const aliases = new Set<string>();
  for (const spec of root.descendantsOfType("import_spec")) {
    const path = spec.childForFieldName("path")?.text.replace(/^`|`$/g, "").replace(/^"|"$/g, "");
    if (path !== "github.com/spf13/cobra") continue;
    const name = spec.childForFieldName("name")?.text;
    if (name === "." || name === "_") continue;
    aliases.add(name ?? "cobra");
  }
  return aliases;
}

function importedNonNilErrorConstructors(root: Node): Set<string> {
  const constructors = new Set<string>();
  for (const spec of root.descendantsOfType("import_spec")) {
    const path = spec.childForFieldName("path")?.text.replace(/^`|`$/g, "").replace(/^"|"$/g, "");
    if (path !== "errors" && path !== "fmt") continue;
    const name = spec.childForFieldName("name")?.text;
    if (name === ".") {
      constructors.add(path === "errors" ? "New" : "Errorf");
    } else if (name !== "_") {
      constructors.add(`${name ?? path}.${path === "errors" ? "New" : "Errorf"}`);
    }
  }
  return constructors;
}

function keyedFields(literal: Node): Map<string, Node> {
  const fields = new Map<string, Node>();
  const body = literal.childForFieldName("body");
  if (body === null) return fields;
  for (const element of body.namedChildren.filter((child) => child.type === "keyed_element")) {
    const key = unwrap(element.childForFieldName("key"));
    const value = unwrap(element.childForFieldName("value"));
    if (key?.type === "identifier" && value !== undefined) fields.set(key.text, value);
  }
  return fields;
}

function unwrap(node: Node | null): Node | undefined {
  let current = node ?? undefined;
  while (
    current !== undefined &&
    ["literal_element", "parenthesized_expression"].includes(current.type) &&
    current.namedChildCount === 1
  ) {
    current = current.namedChild(0) ?? undefined;
  }
  return current;
}

function positionalParameterName(callback: Node): string | undefined {
  const parameters = callback.childForFieldName("parameters");
  if (parameters === null) return undefined;
  for (const declaration of parameters.namedChildren) {
    const type = declaration.childForFieldName("type");
    if (type?.text !== "[]string") continue;
    const names = declaration.childrenForFieldName("name");
    const name = names.at(-1)?.text;
    if (name !== undefined && name !== "_") return name;
  }
  return undefined;
}

function minimumProvenByValidator(
  validator: Node,
  declarations: Map<string, Node>,
  cobraAliases: Set<string>,
  nonNilErrorConstructors: Set<string>,
): number | undefined {
  const value = unwrap(validator);
  if (value === undefined) return undefined;
  if (value.type === "call_expression") {
    const functionName = value.childForFieldName("function")?.text;
    const args = value.childForFieldName("arguments")?.namedChildren ?? [];
    const known = [...cobraAliases].find((alias) => functionName?.startsWith(`${alias}.`));
    if (known === undefined) return undefined;
    if (functionName === `${known}.ExactArgs` || functionName === `${known}.MinimumNArgs`) {
      return integerLiteral(args[0]);
    }
    if (functionName === `${known}.RangeArgs`) return integerLiteral(args[0]);
    if (functionName === `${known}.MaximumNArgs` || functionName === `${known}.NoArgs`) return 0;
    return undefined;
  }
  if (value.type === "func_literal") return minimumProvenByCustomValidator(value, nonNilErrorConstructors);
  if (value.type === "identifier") {
    const declaration = declarations.get(value.text);
    return declaration === undefined
      ? undefined
      : minimumProvenByCustomValidator(declaration, nonNilErrorConstructors);
  }
  return undefined;
}

function minimumProvenByCustomValidator(fn: Node, nonNilErrorConstructors: Set<string>): number | undefined {
  const argsName = positionalParameterName(fn);
  const body = fn.childForFieldName("body");
  if (argsName === undefined || body === null) return undefined;
  const statements = statementList(body)?.namedChildren ?? [];
  let minimum = 0;
  let index = 0;
  for (; index < statements.length; index += 1) {
    const statement = statements[index]!;
    if (statement.type !== "if_statement") break;
    const consequence = statement.childForFieldName("consequence");
    const condition = statement.childForFieldName("condition");
    if (
      consequence === null ||
      condition === null ||
      !returnsNonNil(consequence, nonNilErrorConstructors)
    ) break;
    const guarded = rejectedMinimum(condition, argsName);
    if (guarded === undefined) break;
    minimum = Math.max(minimum, guarded);
  }
  const tail = statements.slice(index);
  if (tail.length === 1 && tail[0]!.text.replace(/\s/g, "") === "returnnil") return minimum;
  return minimum > 0 ? minimum : undefined;
}

function returnsNonNil(block: Node, nonNilErrorConstructors: Set<string>): boolean {
  const statements = statementList(block)?.namedChildren ?? [];
  if (statements.length === 0) return false;
  const last = statements.at(-1)!;
  if (last.type !== "return_statement") return false;
  const value = last.namedChild(0);
  if (value?.type !== "call_expression") return false;
  const constructor = value.childForFieldName("function")?.text;
  // These standard constructors are documented to always return a non-nil
  // error. An arbitrary call or identifier could still evaluate to nil, so it
  // cannot mechanically prove that the validator rejects the short input.
  return constructor !== undefined && nonNilErrorConstructors.has(constructor);
}

interface PositionalAccess {
  node: Node;
  required: number;
}

function positionalAccesses(callback: Node, argsName: string): PositionalAccess[] {
  const accesses: PositionalAccess[] = [];
  for (const node of callback.descendantsOfType(["index_expression", "slice_expression"])) {
    if (nearestFunction(node)?.equals(callback) !== true) continue;
    if (node.childForFieldName("operand")?.text !== argsName) continue;
    if (isShadowedBeforeAccess(node, callback, argsName)) continue;
    if (node.type === "index_expression") {
      const index = integerLiteral(node.childForFieldName("index") ?? undefined);
      if (index !== undefined) accesses.push({ node, required: index + 1 });
      continue;
    }
    const start = integerLiteral(node.childForFieldName("start") ?? undefined) ?? 0;
    const end = integerLiteral(node.childForFieldName("end") ?? undefined) ?? 0;
    const capacity = integerLiteral(node.childForFieldName("capacity") ?? undefined) ?? 0;
    const required = Math.max(start, end, capacity);
    if (required > 0) accesses.push({ node, required });
  }
  return accesses;
}

function nearestFunction(node: Node): Node | null {
  for (let current = node.parent; current !== null; current = current.parent) {
    if (current.type === "func_literal" || current.type === "function_declaration") return current;
  }
  return null;
}

function integerLiteral(node: Node | undefined): number | undefined {
  if (node?.type !== "int_literal" || !/^\d+$/.test(node.text)) return undefined;
  const value = Number(node.text);
  return Number.isSafeInteger(value) ? value : undefined;
}

function minimumProvenAtAccess(access: Node, callback: Node, argsName: string): number {
  let minimum = 0;
  for (let current: Node | null = access; current !== null && !current.equals(callback); current = current.parent) {
    const parent = current.parent;
    if (parent?.type === "if_statement") {
      const condition = parent.childForFieldName("condition");
      const consequence = parent.childForFieldName("consequence");
      const alternative = parent.childForFieldName("alternative");
      if (condition !== null && consequence !== null && contains(consequence, access)) {
        minimum = Math.max(minimum, acceptedMinimum(condition, argsName) ?? 0);
      } else if (condition !== null && alternative !== null && contains(alternative, access)) {
        minimum = Math.max(minimum, rejectedMinimum(condition, argsName) ?? 0);
      }
    }
    if (parent?.type === "expression_case") {
      const switchNode = parent.parent;
      const expression = switchNode?.childForFieldName("value") ?? switchNode?.childForFieldName("expression");
      if (switchNode?.type === "expression_switch_statement" && expression?.text.replace(/\s/g, "") === `len(${argsName})`) {
        const valueList = parent.childForFieldName("value");
        const values = valueList?.type === "expression_list" ? valueList.namedChildren : valueList === null ? [] : [valueList];
        const exact = values.map((value) => integerLiteral(value)).filter((value): value is number => value !== undefined);
        if (exact.length > 0) minimum = Math.max(minimum, Math.min(...exact));
      }
    }
  }

  const body = callback.childForFieldName("body");
  const list = body === null ? undefined : statementList(body);
  if (list !== undefined) {
    const owner = directStatementContaining(list, access);
    if (owner !== undefined) {
      for (const prior of list.namedChildren) {
        if (prior.equals(owner)) break;
        if (prior.type !== "if_statement") continue;
        const condition = prior.childForFieldName("condition");
        const consequence = prior.childForFieldName("consequence");
        if (condition === null || consequence === null || !alwaysExits(consequence)) continue;
        minimum = Math.max(minimum, rejectedMinimum(condition, argsName) ?? 0);
      }
    }
  }
  return minimum;
}

function statementList(block: Node): Node | undefined {
  return block.namedChildren.find((child) => child.type === "statement_list");
}

function directStatementContaining(list: Node, descendant: Node): Node | undefined {
  return list.namedChildren.find((statement) => contains(statement, descendant));
}

function isShadowedBeforeAccess(access: Node, callback: Node, argsName: string): boolean {
  for (let current = access.parent; current !== null && !current.equals(callback); current = current.parent) {
    if (current.type !== "block") continue;
    const list = statementList(current);
    if (list === undefined) continue;
    const owner = directStatementContaining(list, access);
    if (owner === undefined) continue;
    for (const prior of list.namedChildren) {
      if (prior.equals(owner)) break;
      if (prior.type !== "short_var_declaration") continue;
      const left = prior.childForFieldName("left");
      if (left?.namedChildren.some((name) => name.type === "identifier" && name.text === argsName)) {
        return true;
      }
    }
  }
  return false;
}

function contains(ancestor: Node, descendant: Node): boolean {
  return ancestor.equals(descendant) || ancestor.childWithDescendant(descendant) !== null;
}

function alwaysExits(block: Node): boolean {
  const statements = statementList(block)?.namedChildren ?? [];
  const last = statements.at(-1);
  return last?.type === "return_statement" || /\bpanic\s*\(/.test(last?.text ?? "");
}

function acceptedMinimum(condition: Node, argsName: string): number | undefined {
  const text = normalizedCondition(condition.text);
  const len = escaped(`len(${argsName})`);
  return matchMinimum(text, [
    [new RegExp(`^${len}>=(\\d+)$`), 0],
    [new RegExp(`^${len}>(\\d+)$`), 1],
    [new RegExp(`^${len}==(\\d+)$`), 0],
    [new RegExp(`^(\\d+)<=${len}$`), 0],
    [new RegExp(`^(\\d+)<${len}$`), 1],
    [new RegExp(`^${len}!=0$`), 1, true],
  ]);
}

function rejectedMinimum(condition: Node, argsName: string): number | undefined {
  const text = normalizedCondition(condition.text);
  const len = escaped(`len(${argsName})`);
  return matchMinimum(text, [
    [new RegExp(`^${len}<(\\d+)$`), 0],
    [new RegExp(`^${len}<=(\\d+)$`), 1],
    [new RegExp(`^(\\d+)>${len}$`), 0],
    [new RegExp(`^(\\d+)>=${len}$`), 1],
    [new RegExp(`^${len}==0$`), 1, true],
    [new RegExp(`^${len}!=(\\d+)$`), 0],
  ]);
}

function matchMinimum(
  text: string,
  patterns: Array<[RegExp, number, boolean?]>,
): number | undefined {
  for (const [pattern, increment, fixed] of patterns) {
    const match = text.match(pattern);
    if (match === null) continue;
    if (fixed === true) return increment;
    const literal = Number(match[1]);
    if (Number.isSafeInteger(literal)) return literal + increment;
  }
  return undefined;
}

function normalizedCondition(text: string): string {
  let normalized = text.replace(/\s/g, "");
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deduplicate(signals: Signal[]): Signal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${signal.path}:${signal.line}:${signal.snippet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
