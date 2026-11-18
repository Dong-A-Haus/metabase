import { t } from "ttag";

import { skipToken } from "metabase/api";
import * as Urls from "metabase/urls";
import {
  useGetCardTestQuery,
  useListCardTestsQuery,
  useRunCardTestMutation,
} from "metabase-enterprise/api";
import type { CardId, CardTest } from "metabase-types/api";

import { trackCardTestTriggerManualRun } from "../../analytics";
import type {
  DataTestReadOnlyResult,
  DataTestTypeDefinition,
} from "../../types";

import { CardLink } from "./CardLink";
import { CardTestDefinition } from "./CardTestDefinition";

function useListCardTestsBySubjectQuery(cardId: CardId | typeof skipToken) {
  return useListCardTestsQuery(
    cardId === skipToken ? skipToken : { "card-id": cardId },
  );
}

function useCardReadOnly(
  _cardId: CardId | typeof skipToken,
  tests: readonly CardTest[],
): DataTestReadOnlyResult {
  return {
    readOnly: !tests.some((test) => test.can_run),
    isLoading: false,
  };
}

export const cardTestDefinition: DataTestTypeDefinition<CardTest> = {
  useGetTestQuery: useGetCardTestQuery,
  useListTestsQuery: useListCardTestsBySubjectQuery,
  useRunTestMutation: useRunCardTestMutation,
  useReadOnly: useCardReadOnly,
  getSubjectId: (test) => test.card_id,
  getTestUrl: (test) => Urls.dataStudioMetricTest(test.card_id, test.id),
  getTestRunsUrl: (test, params) =>
    Urls.dataStudioMetricTestRuns(test.card_id, test.id, params),
  trackManualRun: trackCardTestTriggerManualRun,
  getListLabel: () => t`Tests`,
  getRunDescription: () =>
    t`Runs the query on the test data and checks the rows it returns. The real tables aren't touched.`,
  SubjectLink: CardLink,
  TestDefinition: CardTestDefinition,
};
