import _ from "underscore";

import { stableStringify } from "metabase/utils/objects";
import type * as Lib from "metabase-lib";

import { getLegacyStage } from "../../../../utils/summary-formulas";

import type { SummaryWellId } from "./types";
import { getDimensionItems, getResultColumnNames } from "./utils";

export function getRowAndColumnItems(
  query: Lib.Query,
  stageIndex: number,
  rowKeys: string[],
) {
  const [rowItems, columnItems] = _.partition(
    getDimensionItems(query, stageIndex),
    (item) => rowKeys.includes(item.key),
  );
  return { rowItems, columnItems };
}

type Grouping = {
  key: string;
  signature: string;
};

function getGroupings(query: Lib.Query, stageIndex: number): Grouping[] {
  const breakouts: unknown = getLegacyStage(query, stageIndex)?.breakout;
  const refs: unknown[] = Array.isArray(breakouts) ? breakouts : [];
  return getResultColumnNames(query, stageIndex).breakoutNames.map(
    (key, index) => ({ key, signature: stableStringify(refs[index]) }),
  );
}

type NextRowKeysOpts = {
  query: Lib.Query;
  nextQuery: Lib.Query;
  stageIndex: number;
  rowKeys: string[];
  /** The well that takes the groupings `nextQuery` adds. */
  addedWellId?: SummaryWellId;
};

/**
 * The keys of the Rows groupings after `query` becomes `nextQuery`. Keys are result column names,
 * which shift when another grouping of the same column goes away, so groupings are matched by
 * their references. A grouping that is changed in place stays in the well it was in.
 */
export function getNextRowKeys({
  query,
  nextQuery,
  stageIndex,
  rowKeys,
  addedWellId,
}: NextRowKeysOpts): string[] {
  if (rowKeys.length === 0 && addedWellId !== "rows") {
    return rowKeys;
  }
  const groupings = getGroupings(query, stageIndex);
  const nextGroupings = getGroupings(nextQuery, stageIndex);
  const isRowBySignature = new Map(
    groupings.map(({ key, signature }) => [signature, rowKeys.includes(key)]),
  );
  const isChangedInPlace =
    addedWellId === undefined && groupings.length === nextGroupings.length;

  return nextGroupings
    .filter(({ signature }, index) => {
      const wasRow = isRowBySignature.get(signature);
      if (wasRow !== undefined) {
        return wasRow;
      }
      if (isChangedInPlace) {
        return rowKeys.includes(groupings[index].key);
      }
      return addedWellId === "rows";
    })
    .map(({ key }) => key);
}
