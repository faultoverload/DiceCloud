import { has } from 'lodash';
import { resolveCalculationNode } from '/imports/api/engine/computation/computeComputation/computeByType/computeCalculation';
import toPrimitiveOrString from '/imports/parser/toPrimitiveOrString';

/**
 * Work out what a point buy row costs
 * @param cost The cost calculation of the row or of its point buy
 * @param scope The scope to resolve the calculation in, with `value` set to the value of the row
 * @returns A copy of the cost calculation with its value and errors set, or undefined if there is
 * no cost calculation that can be resolved
 */
export async function resolvePointBuyCost(cost, scope) {
  if (!cost?.parseNode) return;
  const costFunction = EJSON.clone(cost);
  costFunction._parseLevel = 'reduce';
  await resolveCalculationNode(costFunction, costFunction.parseNode, scope);
  costFunction.value = toPrimitiveOrString(costFunction.valueNode);
  return costFunction;
}

export default async function computePointBuy(computation, node) {
  const prop = node.data;
  const min = has(prop, 'min.value') ? prop.min.value : null;
  const max = has(prop, 'max.value') ? prop.max.value : null;
  prop.spent = 0;
  for (const row of prop.values || []) {
    row.spent = 0;
    if (row.value === undefined) continue;

    // Check min and max
    if (min !== null && row.value < min) {
      row.value = min;
    }
    if (max !== null && row.value > max) {
      row.value = max;
    }
    // Evaluate the cost function
    const costFunction = await resolvePointBuyCost(prop.cost, {
      ...computation.scope, value: row.value
    });
    if (!costFunction) continue;
    // Write calculation errors
    costFunction.errors?.forEach(error => {
      if (error?.message) {
        row.errors = row.errors || [];
        error.message = 'Cost calculation error.\n' + error.message;
        row.errors.push(error);
      }
    });
    if (Number.isFinite(costFunction.value)) {
      row.spent = costFunction.value;
      prop.spent += costFunction.value;
    }
  }
  prop.pointsLeft = (prop.total?.value || 0) - (prop.spent || 0);
  if (prop.spent > prop.total?.value) {
    prop.errors = prop.errors || [];
    prop.errors.push({
      type: 'pointBuyError',
      message: 'Spent more than total points available',
    });
  }
}
