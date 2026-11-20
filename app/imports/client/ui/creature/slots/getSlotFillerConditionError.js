import resolve from '/imports/parser/resolve';
import toString from '/imports/parser/toString';
import { parse, prettifyParseError } from '/imports/parser/parser';

/**
 * Check the condition of a slot filler against the variables of a creature.
 *
 * Resolving a calculation is asynchronous, so the result of this function must be awaited
 * before a filler is shown as available or not.
 *
 * @param node A library node that may have a slotFillerCondition
 * @param variables The creature's variables, the scope the condition is resolved in
 * @returns The reason the filler can't be used, or undefined if its condition is met
 */
export default async function getSlotFillerConditionError(node, variables) {
  if (!node.slotFillerCondition) return undefined;
  try {
    const parseNode = parse(node.slotFillerCondition);
    const { result: resultNode } = await resolve('reduce', parseNode, variables);
    if (resultNode?.parseType === 'constant') {
      if (resultNode.value) return undefined;
      return node.slotFillerConditionNote || node.slotFillerCondition;
    }
    // The condition didn't reduce to a value, show what it did reduce to
    return node.slotFillerConditionNote || toString(resultNode);
  } catch (e) {
    console.warn(e);
    return 'Condition error: ' + prettifyParseError(e);
  }
}
