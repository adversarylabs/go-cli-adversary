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
      const unwrappedCallbackValue = callbackValue === undefined ? undefined : unwrap(callbackValue);
      const callbackBinding = unwrappedCallbackValue?.type === "identifier" ? unwrappedCallbackValue : undefined;
      const evidence = [callbackBinding, validator, ...assignments, ...relevantGuardConditions(access.node, callback, argsName)]
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
    if (isNameShadowedAt(validator, value.text)) return undefined;
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
  if (constructor === undefined || !nonNilErrorConstructors.has(constructor)) return false;
  const binding = constructor.split(".")[0]!;
  return !isNameShadowedAt(value, binding);
}

interface PositionalAccess {
  node: Node;
  required: number;
}

function positionalAccesses(callback: Node, argsName: string): PositionalAccess[] {
  const accesses: PositionalAccess[] = [];
  for (const node of callback.descendantsOfType(["index_expression", "slice_expression"])) {
    const owner = nearestFunction(node);
    if (owner === null) continue;
    if (!owner.equals(callback) && !isImmediatelyExecutedClosure(owner, callback)) continue;
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

function isImmediatelyExecutedClosure(owner: Node, callback: Node): boolean {
  return closureInvocation(owner, callback) !== undefined;
}

function closureInvocation(
  owner: Node,
  callback: Node,
): { node: Node; kind: "direct" | "defer" | "go" } | undefined {
  if (owner.type !== "func_literal") return undefined;
  for (let current: Node | null = owner.parent; current !== null && !current.equals(callback); current = current.parent) {
    if (["parenthesized_expression", "literal_element"].includes(current.type)) continue;
    if (current.type !== "call_expression") return undefined;
    const fn = current.childForFieldName("function");
    if (fn === null || !contains(fn, owner)) return undefined;
    const parent = current.parent;
    if (parent?.type === "defer_statement") return { node: parent, kind: "defer" };
    if (parent?.type === "go_statement") return { node: parent, kind: "go" };
    return { node: current, kind: "direct" };
  }
  return undefined;
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
    if (parent?.type === "for_statement") {
      const condition = forCondition(parent);
      const body = parent.childForFieldName("body");
      if (
        condition !== undefined &&
        condition.endIndex > proofAfterIndex &&
        body !== null &&
        contains(body, access)
      ) {
        minimum = Math.max(minimum, acceptedMinimum(condition, argsName) ?? 0);
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
        minimum = Math.max(minimum, minimumForEnteredSwitchCase(parent, switchNode));
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
      const alternative = prior.childForFieldName("alternative");
      if (condition === null || consequence === null) continue;
      if (blockSkipsAccess(consequence, access)) {
        minimum = Math.max(minimum, rejectedMinimum(condition, argsName) ?? 0);
      } else if (alternative !== null && blockSkipsAccess(alternative, access)) {
        minimum = Math.max(minimum, acceptedMinimum(condition, argsName) ?? 0);
      }
    }
    for (const prior of list.namedChildren) {
      if (prior.equals(owner)) break;
      if (prior.type !== "expression_switch_statement" || prior.endIndex <= proofAfterIndex) continue;
      minimum = Math.max(minimum, minimumAfterSwitch(prior, access, argsName));
    }
  }
  minimum = Math.max(minimum, minimumFromEnclosingSwitchDefault(access, callback, argsName, proofAfterIndex));
  return minimum;
}

function forCondition(statement: Node): Node | undefined {
  const clause = statement.namedChildren.find((child) => child.type === "for_clause");
  if (clause !== undefined) return clause.childForFieldName("condition") ?? undefined;
  return statement.namedChildren.find((child) => child.type !== "block" && child.type !== "range_clause");
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
    if (current.type === "func_literal") {
      const parameters = current.childForFieldName("parameters");
      if (parameters !== null && declarationNames(parameters).has(name)) return true;
    }
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
  if (node.type === "communication_case") {
    const communication = node.childForFieldName("communication");
    return communication?.type === "receive_statement" &&
      communication.text.includes(":=") &&
      expressionListContainsName(communication.childForFieldName("left"), name);
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
  for (const declaration of node.descendantsOfType(["parameter_declaration", "var_spec", "const_spec", "type_spec"])) {
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
      assignedMinimum(assignment, argsName, minimum) ?? 0,
      minimumProvenOnAssignmentPath(assignment, access, argsName),
    );
    minimum = assignmentDominatesAccess(assignment, access) ? assigned : Math.min(minimum, assigned);
  }
  return {
    nodes,
    minimum,
    // A later outer write can run before a deferred/concurrent closure even
    // though it appears after the closure body in source. It invalidates the
    // validator state, but must not hide guards that execute inside the
    // closure immediately before the access.
    proofAfterIndex: nodes
      .filter((node) => node.startIndex < access.startIndex)
      .reduce((latest, node) => Math.max(latest, node.endIndex), -1),
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
    const alternative = statement.childForFieldName("alternative");
    if (condition === null || consequence === null) continue;
    if (blockSkipsAccess(consequence, access)) {
      minimum = Math.max(minimum, rejectedMinimum(condition, argsName) ?? 0);
    } else if (alternative !== null && blockSkipsAccess(alternative, access)) {
      minimum = Math.max(minimum, acceptedMinimum(condition, argsName) ?? 0);
    }
  }
  return minimum;
}

function priorAssignments(access: Node, callback: Node, argsName: string): Node[] {
  const candidates = callback.descendantsOfType(["assignment_statement", "range_clause", "receive_statement"]);
  const accessOwner = nearestFunction(access);
  const delayedInvocation = accessOwner === null || accessOwner.equals(callback)
    ? undefined
    : delayedClosureInvocation(accessOwner, callback);
  const sorted = candidates
    .filter((node) => {
      const owner = nearestFunction(node);
      const ownerInvocation = owner === null || owner.equals(callback)
        ? undefined
        : closureInvocation(owner, callback);
      if (
        owner === null ||
        (!owner.equals(callback) && ownerInvocation === undefined) ||
        (accessOwner?.equals(callback) === true && ownerInvocation?.kind === "defer")
      ) return false;
      const lexicallyPrior = node.startIndex < access.startIndex;
      const laterOuterWrite = delayedInvocation !== undefined &&
        owner.equals(callback) &&
        node.startIndex > delayedInvocation.endIndex;
      if (!lexicallyPrior && !laterOuterWrite) return false;
      if (!canReachAccessAfter(node, access, callback)) return false;
      if (node.type === "range_clause") {
        return !node.text.includes(":=") && expressionListContainsName(node.childForFieldName("left"), argsName);
      }
      if (node.type === "receive_statement") {
        return !node.text.includes(":=") && expressionListContainsName(node.childForFieldName("left"), argsName);
      }
      return expressionListContainsName(node.childForFieldName("left"), argsName);
    })
    .sort((left, right) => left.startIndex - right.startIndex);
  return sorted.filter((assignment, index) =>
    !assignmentIsNoOp(assignment, argsName) &&
    !sorted.slice(index + 1).some((later) => unconditionallyOverwrites(assignment, later)));
}

function assignmentIsNoOp(assignment: Node, argsName: string): boolean {
  return assignedValue(assignment, argsName)?.text === argsName;
}

function delayedClosureInvocation(owner: Node, callback: Node): Node | undefined {
  const invocation = closureInvocation(owner, callback);
  return invocation?.kind === "defer" || invocation?.kind === "go" ? invocation.node : undefined;
}

function unconditionallyOverwrites(assignment: Node, later: Node): boolean {
  return assignment.type === "assignment_statement" &&
    later.type === "assignment_statement" &&
    assignment.parent?.type === "statement_list" &&
    later.parent?.equals(assignment.parent) === true;
}

function canReachAccessAfter(node: Node, access: Node, callback: Node): boolean {
  for (let current = node.parent; current !== null && !current.equals(callback); current = current.parent) {
    if (contains(current, access)) continue;
    if (current.type === "communication_case" && current.parent?.type === "select_statement" &&
      contains(current.parent, access)) return false;
    if (["expression_case", "type_case", "default_case"].includes(current.type) &&
      current.parent !== null && contains(current.parent, access) &&
      !caseFallsThroughTo(current, access)) return false;
    if (current.type === "block" && blockSkipsAccess(current, access)) return false;
    if (current.type === "expression_case" || current.type === "default_case") {
      if (caseSkipsAccess(current, access)) return false;
    }
  }
  return true;
}

function caseFallsThroughTo(source: Node, access: Node): boolean {
  const statement = source.parent;
  if (statement?.type !== "expression_switch_statement") return false;
  const cases = statement.namedChildren.filter((child) =>
    child.type === "expression_case" || child.type === "default_case");
  const sourceIndex = cases.findIndex((item) => item.equals(source));
  const targetIndex = cases.findIndex((item) => contains(item, access));
  if (sourceIndex < 0 || targetIndex <= sourceIndex) return false;
  for (let index = sourceIndex; index < targetIndex; index += 1) {
    if (!caseFallsThrough(cases[index]!)) return false;
  }
  return true;
}

function assignedMinimum(assignment: Node, argsName: string, currentMinimum: number): number | undefined {
  const value = assignedValue(assignment, argsName);
  if (value?.type === "composite_literal" && value.childForFieldName("type")?.text === "[]string") {
    const body = value.childForFieldName("body");
    return body?.namedChildren.length ?? 0;
  }
  if (value?.type === "call_expression" && value.childForFieldName("function")?.text === "make") {
    const args = value.childForFieldName("arguments")?.namedChildren ?? [];
    if (args[0]?.text === "[]string") return integerLiteral(args[1]);
  }
  if (value?.type === "call_expression" && value.childForFieldName("function")?.text === "append") {
    const args = value.childForFieldName("arguments")?.namedChildren ?? [];
    if (args.length === 0) return undefined;
    const fixedAppends = args.slice(1).filter((item) => item.type !== "variadic_argument").length;
    const preserved = args[0]?.text === argsName ? currentMinimum : 0;
    return Math.max(preserved, fixedAppends);
  }
  return undefined;
}

function assignedValue(assignment: Node, argsName: string): Node | undefined {
  if (assignment.type !== "assignment_statement" && assignment.type !== "receive_statement") return undefined;
  const left = assignment.childForFieldName("left")?.namedChildren ?? [];
  const position = left.findIndex((candidate) => candidate.type === "identifier" && candidate.text === argsName);
  if (position < 0) return undefined;
  return assignment.childForFieldName("right")?.namedChildren[position];
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
    if (current.type === "for_statement") {
      const condition = forCondition(current);
      if (condition?.text.includes(`len(${argsName})`)) conditions.push(condition);
    }
    if (current.type === "expression_switch_statement") {
      const expression = switchExpression(current);
      if (expression?.text.includes(`len(${argsName})`)) conditions.push(expression);
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
    for (const prior of list.namedChildren) {
      if (prior.equals(owner)) break;
      if (prior.type !== "expression_switch_statement") continue;
      const expression = switchExpression(prior);
      if (expression?.text.includes(`len(${argsName})`)) conditions.push(expression);
    }
  }
  return conditions;
}

function contains(ancestor: Node, descendant: Node): boolean {
  return ancestor.equals(descendant) || ancestor.childWithDescendant(descendant) !== null;
}

function blockSkipsAccess(node: Node, access: Node): boolean {
  if (node.type === "if_statement") {
    const consequence = node.childForFieldName("consequence");
    const alternative = node.childForFieldName("alternative");
    return consequence !== null && alternative !== null &&
      blockSkipsAccess(consequence, access) && blockSkipsAccess(alternative, access);
  }
  const statements = statementList(node)?.namedChildren ?? node.namedChildren;
  const last = statements.at(-1);
  return last !== undefined && terminalSkipsAccess(last, access);
}

function terminalSkipsAccess(statement: Node, access: Node): boolean {
  if (statement.type === "return_statement") return true;
  if (statement.type === "if_statement") return blockSkipsAccess(statement, access);
  if (statement.type === "expression_switch_statement" || statement.type === "type_switch_statement") {
    return exhaustiveSwitchSkipsAccess(statement, access);
  }
  if (statement.type === "expression_statement") {
    const expression = statement.namedChild(0);
    return expression?.type === "call_expression" &&
      expression.childForFieldName("function")?.text === "panic" &&
      !builtinPanicIsShadowed(expression);
  }
  if (statement.namedChildCount > 0) return false;
  if (statement.type === "continue_statement") {
    if (statement.text.trim() !== "continue") return false;
    const loop = nearestAncestor(statement, new Set(["for_statement"]));
    return loop !== undefined && contains(loop, access);
  }
  if (statement.type === "break_statement") {
    if (statement.text.trim() !== "break") return false;
    const target = nearestAncestor(statement, new Set([
      "for_statement",
      "expression_switch_statement",
      "type_switch_statement",
      "select_statement",
    ]));
    return target !== undefined && contains(target, access);
  }
  return false;
}

function exhaustiveSwitchSkipsAccess(statement: Node, access: Node): boolean {
  const cases = statement.namedChildren.filter((child) =>
    child.type === "expression_case" || child.type === "type_case" || child.type === "default_case");
  if (cases.length === 0 || !cases.some((item) => item.type === "default_case")) return false;
  return cases.every((_, index) => {
    let target = index;
    while (caseFallsThrough(cases[target]!)) {
      target += 1;
      if (target >= cases.length) return false;
    }
    return caseSkipsAccess(cases[target]!, access);
  });
}

function builtinPanicIsShadowed(reference: Node): boolean {
  if (isNameShadowedAt(reference, "panic")) return true;
  let root: Node = reference;
  while (root.parent !== null) root = root.parent;
  for (const declaration of root.namedChildren) {
    if (declaration.type === "function_declaration" && declaration.childForFieldName("name")?.text === "panic") {
      return true;
    }
    if (["var_declaration", "const_declaration", "type_declaration"].includes(declaration.type) &&
      declarationNames(declaration).has("panic")) return true;
  }
  return false;
}

function nearestAncestor(node: Node, types: Set<string>): Node | undefined {
  for (let current = node.parent; current !== null; current = current.parent) {
    if (types.has(current.type)) return current;
  }
  return undefined;
}

function minimumAfterSwitch(statement: Node, access: Node, argsName: string): number {
  const expression = switchExpression(statement);
  if (expression?.text.replace(/\s/g, "") !== `len(${argsName})`) return 0;
  const cases = statement.namedChildren.filter((child) => child.type === "expression_case" || child.type === "default_case");
  const explicit = new Map<number, Node>();
  let fallback: Node | undefined;
  for (const item of cases) {
    const values = switchCaseValues(item);
    if (values === undefined) return 0;
    if (values.length === 0) fallback = item;
    for (const value of values) explicit.set(value, item);
  }
  const max = Math.max(0, ...explicit.keys());
  for (let value = 0; value <= max + 1; value += 1) {
    const item = explicit.get(value) ?? fallback;
    if (item === undefined || !caseSkipsAccess(item, access)) return value;
  }
  return Number.MAX_SAFE_INTEGER;
}

function minimumFromEnclosingSwitchDefault(
  access: Node,
  callback: Node,
  argsName: string,
  proofAfterIndex: number,
): number {
  for (let current: Node | null = access; current !== null && !current.equals(callback); current = current.parent) {
    if (current.type !== "default_case") continue;
    const statement = current.parent;
    const expression = statement?.type === "expression_switch_statement" ? switchExpression(statement) : undefined;
    if (
      statement === null ||
      statement === undefined ||
      expression === undefined ||
      expression.endIndex <= proofAfterIndex ||
      expression.text.replace(/\s/g, "") !== `len(${argsName})`
    ) return 0;
    const covered = new Set<number>();
    for (const item of statement.namedChildren.filter((child) => child.type === "expression_case" && !child.equals(current))) {
      const values = switchCaseValues(item);
      if (values === undefined || caseFallsThrough(item)) return 0;
      for (const value of values) covered.add(value);
    }
    let minimum = 0;
    while (covered.has(minimum)) minimum += 1;
    return minimum;
  }
  return 0;
}

function switchExpression(statement: Node): Node | undefined {
  return statement.childForFieldName("value") ?? statement.childForFieldName("expression") ??
    statement.namedChildren.find((child) => child.type !== "expression_case");
}

function switchCaseValues(item: Node): number[] | undefined {
  const value = item.childForFieldName("value");
  if (value === null) return [];
  const nodes = value.type === "expression_list" ? value.namedChildren : [value];
  const values = nodes.map((node) => integerLiteral(node));
  return values.every((item): item is number => item !== undefined) ? values : undefined;
}

function minimumForEnteredSwitchCase(item: Node, statement: Node): number {
  const cases = statement.namedChildren.filter((child) =>
    child.type === "expression_case" || child.type === "default_case");
  let index = cases.findIndex((candidate) => candidate.equals(item));
  if (index < 0) return 0;
  const possible: number[] = [];
  const own = switchCaseValues(cases[index]!);
  if (own === undefined || own.length === 0) return 0;
  possible.push(...own);
  while (index > 0 && caseFallsThrough(cases[index - 1]!)) {
    index -= 1;
    const predecessor = switchCaseValues(cases[index]!);
    if (predecessor === undefined || predecessor.length === 0) return 0;
    possible.push(...predecessor);
  }
  return Math.min(...possible);
}

function caseSkipsAccess(item: Node, access: Node): boolean {
  const statements = statementList(item)?.namedChildren ?? [];
  const last = statements.at(-1);
  return last !== undefined && terminalSkipsAccess(last, access);
}

function caseFallsThrough(item: Node): boolean {
  return statementList(item)?.namedChildren.at(-1)?.type === "fallthrough_statement";
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
