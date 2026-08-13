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
    const callbackKind = fields.has("RunE") ? "RunE" : fields.has("Run") ? "Run" : undefined;
    const callbackValue = callbackKind === undefined ? undefined : fields.get(callbackKind);
    const callback = callbackValue === undefined || callbackKind === undefined
      ? undefined
      : resolveCallback(callbackValue, literal, callbackKind, declarations, cobraAliases);
    if (callback === undefined) continue;

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
      const assignmentState = minimumAfterAssignments(
        access.node,
        callback,
        argsName,
        validatorMinimum ?? 0,
      );
      const assignments = assignmentState.nodes;
      const effectiveValidatorMinimum = assignmentState.minimum;
      if (access.required <= effectiveValidatorMinimum) continue;
      if (
        minimumProvenAtAccess(access.node, callback, argsName, assignmentState.proofAfterIndex) >=
        access.required
      ) continue;
      const evidence = [validator, ...assignments, ...relevantGuardConditions(access.node, callback, argsName)]
        .filter((node): node is Node => node !== undefined);
      const anchor = signalAnchor(file, access.node, evidence);
      if (anchor === undefined) continue;
      signals.push({
        ruleId: RULE_ID,
        path: file.path,
        line: anchor.startPosition.row + 1,
        endLine: anchor.endPosition.row + 1,
        message:
          `${argsName} requires at least ${access.required} positional argument${access.required === 1 ? "" : "s"}, ` +
          `but this Cobra command only proves a minimum of ${effectiveValidatorMinimum}.`,
        snippet: anchor.text.trim().slice(0, 300),
        data: {
          requiredMinimum: access.required,
          validatorMinimum: effectiveValidatorMinimum,
          access: access.node.text,
          accessLine: access.node.startPosition.row + 1,
        },
      });
    }
  }
  return deduplicate(signals);
}

function signalAnchor(file: SourceRevision, access: Node, evidence: Node[]): Node | undefined {
  if (file.status === "repository" || file.status === "added") return access;
  const changedLines = file.semanticChangedLines ?? file.changedLines;
  if (nodeTouchesSemanticChangedLine(access, changedLines)) return access;
  for (const node of evidence) {
    if (nodeTouchesSemanticChangedLine(node, changedLines)) return node;
  }
  return undefined;
}

function nodeTouchesSemanticChangedLine(node: Node, changedLines: Set<number>): boolean {
  const leaves = node.namedChildCount === 0 ? [node] : semanticLeaves(node);
  for (const leaf of leaves) {
    if (leaf.type === "comment") continue;
    for (let line = leaf.startPosition.row + 1; line <= leaf.endPosition.row + 1; line += 1) {
      if (changedLines.has(line)) return true;
    }
  }
  return false;
}

function semanticLeaves(node: Node): Node[] {
  const leaves: Node[] = [];
  const pending = [...node.namedChildren];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.namedChildCount === 0) leaves.push(current);
    else pending.push(...current.namedChildren);
  }
  return leaves;
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

function resolveCallback(
  value: Node,
  commandLiteral: Node,
  kind: "Run" | "RunE",
  declarations: Map<string, Node>,
  cobraAliases: Set<string>,
): Node | undefined {
  const callback = unwrap(value);
  if (callback === undefined) return undefined;
  if (callback.type === "func_literal") {
    return hasExactCallbackSignature(callback, kind, cobraAliases) ? callback : undefined;
  }
  if (callback.type !== "identifier" || isNameShadowedAt(commandLiteral, callback.text)) {
    return undefined;
  }
  const declaration = declarations.get(callback.text);
  if (declaration === undefined || !hasExactCallbackSignature(declaration, kind, cobraAliases)) {
    return undefined;
  }
  return declaration;
}

function hasExactCallbackSignature(
  callback: Node,
  kind: "Run" | "RunE",
  cobraAliases: Set<string>,
): boolean {
  const parameters = callback.childForFieldName("parameters");
  if (parameters === null) return false;
  const flattened: Array<{ name: string; type: string }> = [];
  for (const declaration of parameters.namedChildren) {
    if (declaration.type !== "parameter_declaration") return false;
    const type = declaration.childForFieldName("type")?.text;
    const names = declaration.childrenForFieldName("name");
    if (type === undefined || names.length === 0) return false;
    for (const name of names) flattened.push({ name: name.text, type });
  }
  if (flattened.length !== 2) return false;
  const commandType = flattened[0]!.type;
  if (![...cobraAliases].some((alias) => commandType === `*${alias}.Command`)) return false;
  if (flattened[1]!.type !== "[]string" || flattened[1]!.name === "_") return false;
  const result = callback.childForFieldName("result");
  return kind === "RunE" ? isSingleErrorResult(result) : result === null;
}

function isSingleErrorResult(result: Node | null): boolean {
  if (result?.text === "error") return true;
  if (result?.type !== "parameter_list" || result.namedChildren.length !== 1) return false;
  const declaration = result.namedChild(0);
  return declaration?.type === "parameter_declaration" &&
    declaration.childForFieldName("type")?.text === "error" &&
    declaration.childrenForFieldName("name").length === 1;
}

function isNameShadowedAt(reference: Node, name: string): boolean {
  for (let current: Node | null = reference; current !== null; current = current.parent) {
    if (current.type === "block" && priorDeclarationInBlock(current, reference, name)) return true;
    if (controlHeaderDeclares(current, reference, name)) return true;
    if (current.type === "func_literal" || current.type === "function_declaration") {
      const parameters = current.childForFieldName("parameters");
      if (parameters !== null && declarationNames(parameters).has(name)) return true;
      return false;
    }
  }
  return false;
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
    if (isArgsShadowedAt(node, callback, argsName)) continue;
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

function minimumProvenAtAccess(
  access: Node,
  callback: Node,
  argsName: string,
  proofAfterIndex: number,
): number {
  let minimum = 0;
  for (let current: Node | null = access; current !== null && !current.equals(callback); current = current.parent) {
    const parent = current.parent;
    if (parent?.type === "if_statement") {
      const condition = parent.childForFieldName("condition");
      const consequence = parent.childForFieldName("consequence");
      const alternative = parent.childForFieldName("alternative");
      if (
        condition !== null &&
        condition.endIndex > proofAfterIndex &&
        consequence !== null &&
        contains(consequence, access)
      ) {
        minimum = Math.max(minimum, acceptedMinimum(condition, argsName) ?? 0);
      } else if (
        condition !== null &&
        condition.endIndex > proofAfterIndex &&
        alternative !== null &&
        contains(alternative, access)
      ) {
        minimum = Math.max(minimum, rejectedMinimum(condition, argsName) ?? 0);
      }
    }
    if (parent?.type === "expression_case") {
      const switchNode = parent.parent;
      const expression = switchNode?.childForFieldName("value") ?? switchNode?.childForFieldName("expression");
      if (
        switchNode?.type === "expression_switch_statement" &&
        expression !== null &&
        expression !== undefined &&
        expression.endIndex > proofAfterIndex &&
        expression.text.replace(/\s/g, "") === `len(${argsName})`
      ) {
        const valueList = parent.childForFieldName("value");
        const values = valueList?.type === "expression_list" ? valueList.namedChildren : valueList === null ? [] : [valueList];
        const exact = values.map((value) => integerLiteral(value)).filter((value): value is number => value !== undefined);
        if (exact.length > 0) minimum = Math.max(minimum, Math.min(...exact));
      }
    }
  }

  for (let current: Node | null = access; current !== null && !current.equals(callback); current = current.parent) {
    if (current.type !== "block") continue;
    const list = statementList(current);
    const owner = list === undefined ? undefined : directStatementContaining(list, access);
    if (list === undefined || owner === undefined) continue;
    for (const prior of list.namedChildren) {
      if (prior.equals(owner)) break;
      if (prior.type !== "if_statement" || prior.endIndex <= proofAfterIndex) continue;
      const condition = prior.childForFieldName("condition");
      const consequence = prior.childForFieldName("consequence");
      if (condition === null || consequence === null || !alwaysExits(consequence)) continue;
      minimum = Math.max(minimum, rejectedMinimum(condition, argsName) ?? 0);
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

function isArgsShadowedAt(access: Node, callback: Node, name: string): boolean {
  for (let current: Node | null = access.parent; current !== null && !current.equals(callback); current = current.parent) {
    if (current.type === "block" && priorDeclarationInBlock(current, access, name)) return true;
    if (controlHeaderDeclares(current, access, name)) return true;
  }
  return false;
}

function priorDeclarationInBlock(block: Node, reference: Node, name: string): boolean {
  const list = statementList(block);
  const owner = list === undefined ? undefined : directStatementContaining(list, reference);
  if (list === undefined || owner === undefined) return false;
  for (const prior of list.namedChildren) {
    if (prior.equals(owner)) break;
    if (declarationBindsName(prior, name)) return true;
  }
  return false;
}

function controlHeaderDeclares(node: Node, reference: Node, name: string): boolean {
  if (!contains(node, reference)) return false;
  if (node.type === "for_statement") {
    const clause = node.namedChildren.find((child) => child.type === "range_clause" || child.type === "for_clause");
    if (clause?.type === "range_clause") {
      return clause.text.includes(":=") && expressionListContainsName(clause.childForFieldName("left"), name);
    }
    const initializer = clause?.childForFieldName("initializer");
    return initializer !== null && initializer !== undefined && declarationBindsName(initializer, name);
  }
  if (["if_statement", "expression_switch_statement", "type_switch_statement"].includes(node.type)) {
    const initializer = node.childForFieldName("initializer");
    if (initializer !== null && declarationBindsName(initializer, name)) return true;
    const alias = node.childForFieldName("alias");
    return alias?.text === name;
  }
  return false;
}

function declarationBindsName(node: Node, name: string): boolean {
  if (node.type === "short_var_declaration") {
    return expressionListContainsName(node.childForFieldName("left"), name);
  }
  if (node.type === "var_declaration") {
    return node.descendantsOfType("var_spec").some((spec) => declarationNames(spec).has(name));
  }
  return false;
}

function declarationNames(node: Node): Set<string> {
  const names = new Set<string>();
  for (const declaration of node.descendantsOfType(["parameter_declaration", "var_spec"])) {
    for (const name of declaration.childrenForFieldName("name")) names.add(name.text);
  }
  return names;
}

function expressionListContainsName(node: Node | null | undefined, name: string): boolean {
  return node?.namedChildren.some((child) => child.type === "identifier" && child.text === name) ?? false;
}

interface AssignmentState {
  nodes: Node[];
  minimum: number;
  proofAfterIndex: number;
}

function minimumAfterAssignments(
  access: Node,
  callback: Node,
  argsName: string,
  initialMinimum: number,
): AssignmentState {
  const nodes = priorAssignments(access, callback, argsName);
  let minimum = initialMinimum;
  for (const assignment of nodes) {
    const assigned = Math.max(
      assignedMinimum(assignment, argsName) ?? 0,
      minimumProvenOnAssignmentPath(assignment, access, argsName),
    );
    minimum = assignmentDominatesAccess(assignment, access) ? assigned : Math.min(minimum, assigned);
  }
  return {
    nodes,
    minimum,
    proofAfterIndex: nodes.reduce((latest, node) => Math.max(latest, node.endIndex), -1),
  };
}

function minimumProvenOnAssignmentPath(assignment: Node, access: Node, argsName: string): number {
  const list = assignment.parent;
  if (list?.type !== "statement_list") return 0;
  let minimum = 0;
  let afterAssignment = false;
  for (const statement of list.namedChildren) {
    if (statement.equals(assignment)) {
      afterAssignment = true;
      continue;
    }
    if (contains(statement, access)) break;
    if (!afterAssignment || statement.type !== "if_statement") continue;
    const condition = statement.childForFieldName("condition");
    const consequence = statement.childForFieldName("consequence");
    if (condition === null || consequence === null || !alwaysExits(consequence)) continue;
    minimum = Math.max(minimum, rejectedMinimum(condition, argsName) ?? 0);
  }
  return minimum;
}

function priorAssignments(access: Node, callback: Node, argsName: string): Node[] {
  const candidates = callback.descendantsOfType(["assignment_statement", "range_clause"]);
  return candidates
    .filter((node) => {
      if (node.startIndex >= access.startIndex || nearestFunction(node)?.equals(callback) !== true) return false;
      if (!canReachAccessAfter(node, access, callback)) return false;
      if (node.type === "range_clause") {
        return !node.text.includes(":=") && expressionListContainsName(node.childForFieldName("left"), argsName);
      }
      return expressionListContainsName(node.childForFieldName("left"), argsName);
    })
    .sort((left, right) => left.startIndex - right.startIndex);
}

function canReachAccessAfter(node: Node, access: Node, callback: Node): boolean {
  for (let current = node.parent; current !== null && !current.equals(callback); current = current.parent) {
    if (contains(current, access)) continue;
    if (current.type === "block" && alwaysExits(current)) return false;
    if (current.type === "expression_case") {
      const statements = current.namedChildren.filter((child) => child.type !== "expression_list");
      const last = statements.at(-1);
      if (last?.type === "return_statement") return false;
      if (
        last?.type === "expression_statement" &&
        last.namedChild(0)?.type === "call_expression" &&
        last.namedChild(0)?.childForFieldName("function")?.text === "panic"
      ) return false;
    }
  }
  return true;
}

function assignedMinimum(assignment: Node, argsName: string): number | undefined {
  if (assignment.type !== "assignment_statement") return undefined;
  const left = assignment.childForFieldName("left")?.namedChildren ?? [];
  const position = left.findIndex((candidate) => candidate.type === "identifier" && candidate.text === argsName);
  if (position < 0) return undefined;
  const value = assignment.childForFieldName("right")?.namedChildren[position];
  if (value?.type === "composite_literal" && value.childForFieldName("type")?.text === "[]string") {
    const body = value.childForFieldName("body");
    return body?.namedChildren.length ?? 0;
  }
  if (value?.type === "call_expression" && value.childForFieldName("function")?.text === "make") {
    const args = value.childForFieldName("arguments")?.namedChildren ?? [];
    if (args[0]?.text === "[]string") return integerLiteral(args[1]);
  }
  return undefined;
}

function assignmentDominatesAccess(assignment: Node, access: Node): boolean {
  const list = assignment.parent;
  if (list?.type !== "statement_list") return false;
  const owner = directStatementContaining(list, access);
  return owner !== undefined && assignment.endIndex < owner.startIndex;
}

function relevantGuardConditions(access: Node, callback: Node, argsName: string): Node[] {
  const conditions: Node[] = [];
  for (let current: Node | null = access; current !== null && !current.equals(callback); current = current.parent) {
    if (current.type === "if_statement") {
      const condition = current.childForFieldName("condition");
      if (condition !== null && condition.text.includes(`len(${argsName})`)) conditions.push(condition);
    }
    if (current.type !== "block") continue;
    const list = statementList(current);
    const owner = list === undefined ? undefined : directStatementContaining(list, access);
    if (list === undefined || owner === undefined) continue;
    for (const prior of list.namedChildren) {
      if (prior.equals(owner)) break;
      if (prior.type !== "if_statement") continue;
      const condition = prior.childForFieldName("condition");
      if (condition !== null && condition.text.includes(`len(${argsName})`)) conditions.push(condition);
    }
  }
  return conditions;
}

function contains(ancestor: Node, descendant: Node): boolean {
  return ancestor.equals(descendant) || ancestor.childWithDescendant(descendant) !== null;
}

function alwaysExits(block: Node): boolean {
  const statements = statementList(block)?.namedChildren ?? [];
  const last = statements.at(-1);
  if (last?.type === "return_statement") return true;
  if (last?.type !== "expression_statement") return false;
  const expression = last.namedChild(0);
  return expression?.type === "call_expression" && expression.childForFieldName("function")?.text === "panic";
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
