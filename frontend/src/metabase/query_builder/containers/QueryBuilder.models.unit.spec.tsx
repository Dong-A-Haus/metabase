import userEvent from "@testing-library/user-event";
import fetchMock from "fetch-mock";

import { createMockMetadata } from "__support__/metadata";
import {
  setupCardEndpoints,
  setupCardQueryMetadataEndpoint,
  setupDashboardEndpoints,
  setupRecentViewsAndSelectionsEndpoints,
  setupRevisionsEndpoints,
  setupUsersEndpoints,
} from "__support__/server-mocks";
import { setupListNotificationEndpoints } from "__support__/server-mocks/notification";
import {
  mockGetBoundingClientRect,
  screen,
  waitFor,
  within,
} from "__support__/ui";
import { serializeCardForUrl } from "metabase/common/utils/card";
import { registerVisualizations } from "metabase/visualizations/register";
import * as Lib from "metabase-lib";
import {
  SAMPLE_PROVIDER,
  createMetadataProvider,
} from "metabase-lib/test-helpers";
import type { Card, CardType, Dataset, TemplateTag } from "metabase-types/api";
import {
  createMockCard,
  createMockCardQueryMetadata,
  createMockColumn,
  createMockDashboard,
  createMockDataset,
  createMockDatasetData,
  createMockNumericColumn,
  createMockRecentCollectionItem,
  createMockTemplateTag,
  createMockUnsavedCard,
  createMockUserListResult,
} from "metabase-types/api/mocks";
import {
  ORDERS,
  ORDERS_ID,
  PRODUCTS,
  createOrdersCreatedAtDatasetColumn,
  createOrdersTableDatasetColumns,
} from "metabase-types/api/mocks/presets";

import { TEST_DB, setup } from "./test-utils";

registerVisualizations();

afterEach(() => {
  jest.restoreAllMocks();
});

const ACK_KEY_URL =
  "path:/api/user-key-value/namespace/user_acknowledgement/key/turn_into_model_modal";

const ORDERS_BY_YEAR_CARD = createMockCard({
  id: 2,
  name: "Orders by year",
  display: "line",
  dataset_query: Lib.toJsQuery(
    Lib.createTestQuery(SAMPLE_PROVIDER, {
      stages: [
        {
          source: { type: "table", id: ORDERS_ID },
          aggregations: [{ type: "operator", operator: "count", args: [] }],
          breakouts: [{ type: "column", name: "CREATED_AT", unit: "year" }],
        },
      ],
    }),
  ),
});

const ORDERS_BY_YEAR_DATASET = createMockDataset({
  data: createMockDatasetData({
    cols: [
      createOrdersCreatedAtDatasetColumn({
        source: "breakout",
        unit: "year",
        display_name: "Created At: Year",
        field_ref: ["field", ORDERS.CREATED_AT, { "temporal-unit": "year" }],
      }),
      createMockNumericColumn({
        name: "count",
        display_name: "Count",
        source: "aggregation",
        field_ref: ["aggregation", 0],
      }),
    ],
    rows: [
      ["2024-01-01T00:00:00Z", 10],
      ["2025-01-01T00:00:00Z", 20],
    ],
  }),
});

// A model is queried as a nested source, so its columns are referenced by name.
const ORDERS_BY_YEAR_MODEL_DATASET = createMockDataset({
  data: createMockDatasetData({
    cols: [
      createOrdersCreatedAtDatasetColumn({
        display_name: "Created At: Year",
        field_ref: ["field", "CREATED_AT", { "base-type": "type/DateTime" }],
      }),
      createMockNumericColumn({
        name: "count",
        display_name: "Count",
        field_ref: ["field", "count", { "base-type": "type/BigInteger" }],
      }),
    ],
    rows: ORDERS_BY_YEAR_DATASET.data.rows,
  }),
});

const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

interface StatefulCardOpts {
  card: Card;
  questionDataset?: Dataset;
  modelDataset?: Dataset;
}

/**
 * Keeps the card and the "turn into model" acknowledgement as the backend
 * would: each write changes them inside the handler of its request.
 */
function setupStatefulCard({
  card: initialCard,
  questionDataset = ORDERS_BY_YEAR_DATASET,
  modelDataset = ORDERS_BY_YEAR_MODEL_DATASET,
}: StatefulCardOpts) {
  let currentCard = initialCard;
  let acked = false;

  // Registered before `setup` so these routes win over its static card mocks.
  fetchMock.get(`path:/api/card/${initialCard.id}`, () => currentCard);
  fetchMock.put(`path:/api/card/${initialCard.id}`, (call) => {
    const body: unknown = JSON.parse(String(call.options.body));
    if (typeof body === "object" && body !== null) {
      currentCard = Object.assign({}, currentCard, body);
    }
    return currentCard;
  });
  fetchMock.post(`path:/api/card/${initialCard.id}/query`, questionDataset);
  // A model opens as an ad-hoc query on top of the saved card.
  fetchMock.post("path:/api/dataset", (call) =>
    getSourceCardId(call.options.body) === initialCard.id
      ? modelDataset
      : createMockDataset(),
  );
  fetchMock.get(ACK_KEY_URL, () => jsonResponse(acked));
  fetchMock.put(ACK_KEY_URL, () => {
    acked = true;
    return jsonResponse(true);
  });
  setupListNotificationEndpoints({ card_id: initialCard.id }, []);
}

function getSourceCardId(body: unknown) {
  const query: unknown = JSON.parse(String(body));
  if (
    typeof query === "object" &&
    query !== null &&
    "stages" in query &&
    Array.isArray(query.stages)
  ) {
    const [stage]: unknown[] = query.stages;
    if (typeof stage === "object" && stage !== null && "source-card" in stage) {
      return stage["source-card"];
    }
  }
}

function getCreatedQuerySourceCardId(card: unknown) {
  if (typeof card === "object" && card !== null && "dataset_query" in card) {
    return getSourceCardId(JSON.stringify(card.dataset_query));
  }
}

function getCardUpdates(cardId: number): unknown[] {
  return fetchMock.callHistory
    .calls(`path:/api/card/${cardId}`, { method: "PUT" })
    .map((call): unknown => JSON.parse(String(call.options.body)));
}

async function openActionsMenu() {
  await userEvent.click(screen.getByLabelText("Move, trash, and more…"));
  return screen.findByRole("menu");
}

async function closeActionsMenu() {
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
}

async function expectToBeQuestion() {
  const menu = await openActionsMenu();
  expect(
    within(menu).getByRole("menuitem", { name: /Turn into a model/ }),
  ).toBeInTheDocument();
  expect(
    within(menu).queryByRole("menuitem", {
      name: /Turn back to saved question/,
    }),
  ).not.toBeInTheDocument();
  await closeActionsMenu();
  expect(
    within(screen.getByTestId("qb-header-left-side")).getByText(
      "Sample Database",
    ),
  ).toBeInTheDocument();
}

async function expectToBeModel() {
  const menu = await openActionsMenu();
  expect(
    within(menu).getByRole("menuitem", { name: /Turn back to saved question/ }),
  ).toBeInTheDocument();
  expect(
    within(menu).queryByRole("menuitem", { name: /Turn into a model/ }),
  ).not.toBeInTheDocument();
  await closeActionsMenu();
  expect(
    within(screen.getByTestId("qb-header-left-side")).queryByText(
      "Sample Database",
    ),
  ).not.toBeInTheDocument();
}

describe("QueryBuilder > models", () => {
  describe("turning a question into a model", () => {
    it("turns a question into a model, undoes it, and shows the model info modal only once", async () => {
      const card = ORDERS_BY_YEAR_CARD;
      setupStatefulCard({ card });
      await setup({ card, dataset: ORDERS_BY_YEAR_DATASET, withUndos: true });

      expect(await screen.findByTestId("chart-container")).toBeInTheDocument();
      expect(screen.queryByTestId("table-root")).not.toBeInTheDocument();

      const menu = await openActionsMenu();
      await userEvent.click(
        within(menu).getByRole("menuitem", { name: /Turn into a model/ }),
      );
      const modal = await screen.findByRole("dialog", { name: "Models" });
      await userEvent.click(
        within(modal).getByRole("button", { name: "Turn this into a model" }),
      );

      await waitFor(() => expect(getCardUpdates(card.id)).toHaveLength(1));
      expect(getCardUpdates(card.id)[0]).toMatchObject({
        type: "model",
        display: "table",
      });
      expect(await screen.findByTestId("table-root")).toBeInTheDocument();
      expect(screen.queryByTestId("chart-container")).not.toBeInTheDocument();
      await expectToBeModel();

      const toast = await screen.findByTestId("toast-undo");
      expect(within(toast).getByText("This is a model now.")).toBeVisible();
      await userEvent.click(within(toast).getByText("Undo"));

      await waitFor(() => expect(getCardUpdates(card.id)).toHaveLength(2));
      expect(getCardUpdates(card.id)[1]).toMatchObject({
        type: "question",
        display: "line",
      });
      expect(await screen.findByTestId("chart-container")).toBeInTheDocument();
      await expectToBeQuestion();

      const menu2 = await openActionsMenu();
      await userEvent.click(
        within(menu2).getByRole("menuitem", { name: /Turn into a model/ }),
      );
      await waitFor(() => expect(getCardUpdates(card.id)).toHaveLength(3));
      expect(getCardUpdates(card.id)[2]).toMatchObject({ type: "model" });
      expect(await screen.findByTestId("table-root")).toBeInTheDocument();
      expect(
        within(await screen.findByTestId("toast-undo")).getByText(
          "This is a model now.",
        ),
      ).toBeVisible();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  describe("turning a model back into a question", () => {
    it("opens a model by its /question URL at its /model URL, turns it back into a question, and undoes it", async () => {
      const card = createMockCard({
        ...ORDERS_BY_YEAR_CARD,
        name: "Orders model",
        type: "model",
        display: "table",
      });
      setupStatefulCard({ card });
      const { router } = await setup({
        card,
        initialRoute: `/question/${card.id}`,
        withUndos: true,
      });

      await waitFor(() =>
        expect(router.location.pathname).toBe(`/model/${card.id}-orders-model`),
      );
      await expectToBeModel();

      const menu = await openActionsMenu();
      await userEvent.click(
        within(menu).getByRole("menuitem", {
          name: /Turn back to saved question/,
        }),
      );
      await waitFor(() => expect(getCardUpdates(card.id)).toHaveLength(1));
      expect(getCardUpdates(card.id)[0]).toMatchObject({ type: "question" });

      const toast = await screen.findByTestId("toast-undo");
      expect(within(toast).getByText("This is a question now.")).toBeVisible();
      await expectToBeQuestion();

      await userEvent.click(within(toast).getByText("Undo"));
      await waitFor(() => expect(getCardUpdates(card.id)).toHaveLength(2));
      expect(getCardUpdates(card.id)[1]).toMatchObject({ type: "model" });
      await waitFor(() =>
        expect(
          within(screen.getByTestId("qb-header-left-side")).queryByText(
            "Sample Database",
          ),
        ).not.toBeInTheDocument(),
      );
      await expectToBeModel();
    });
  });

  describe("native questions", () => {
    const NATIVE_DATASET = createMockDataset({
      data: createMockDatasetData({
        cols: [
          createMockColumn({
            name: "ID",
            display_name: "ID",
            field_ref: ["field", "ID", { "base-type": "type/BigInteger" }],
          }),
        ],
        rows: [[1], [2]],
      }),
    });

    function createNativeCard(opts: {
      query: string;
      templateTags?: TemplateTag[];
      type?: CardType;
    }) {
      return createMockCard({
        id: 4,
        name: "Native question",
        query_type: "native",
        type: opts.type ?? "question",
        dataset_query: Lib.toJsQuery(
          Lib.withTemplateTags(
            Lib.createTestNativeQuery(SAMPLE_PROVIDER, { query: opts.query }),
            opts.templateTags ?? [],
          ),
        ),
      });
    }

    it("does not turn a native question with variables into a model", async () => {
      const card = createNativeCard({
        query: "SELECT * FROM PRODUCTS WHERE {{ID}}",
        templateTags: [
          createMockTemplateTag({
            name: "ID",
            "display-name": "ID",
            type: "dimension",
            "field-id": PRODUCTS.ID,
            "widget-type": "category",
          }),
        ],
      });
      setupStatefulCard({
        card,
        questionDataset: NATIVE_DATASET,
        modelDataset: NATIVE_DATASET,
      });
      await setup({ card, dataset: NATIVE_DATASET });

      const menu = await openActionsMenu();
      await userEvent.click(
        within(menu).getByRole("menuitem", { name: /Turn into a model/ }),
      );
      const modal = await screen.findByRole("dialog", {
        name: "Variables in models aren't supported yet",
      });
      expect(
        within(modal).queryByRole("button", { name: "Turn this into a model" }),
      ).not.toBeInTheDocument();
      await userEvent.click(within(modal).getByLabelText("Close"));
      await waitFor(() => expect(modal).not.toBeInTheDocument());

      await expectToBeQuestion();
      expect(getCardUpdates(card.id)).toHaveLength(0);
    });

    it("turns a native question that references another card into a model", async () => {
      setupCardEndpoints(createMockCard({ id: 1, name: "Orders" }));
      const card = createNativeCard({
        query: "SELECT * FROM {{#1-orders}}",
        templateTags: [
          createMockTemplateTag({
            name: "#1-orders",
            "display-name": "#1 Orders",
            type: "card",
            "card-id": 1,
          }),
        ],
      });
      setupStatefulCard({
        card,
        questionDataset: NATIVE_DATASET,
        modelDataset: NATIVE_DATASET,
      });
      await setup({ card, dataset: NATIVE_DATASET });

      const menu = await openActionsMenu();
      await userEvent.click(
        within(menu).getByRole("menuitem", { name: /Turn into a model/ }),
      );
      const modal = await screen.findByRole("dialog", { name: "Models" });
      await userEvent.click(
        within(modal).getByRole("button", { name: "Turn this into a model" }),
      );

      await waitFor(() => expect(getCardUpdates(card.id)).toHaveLength(1));
      expect(getCardUpdates(card.id)[0]).toMatchObject({ type: "model" });
      await expectToBeModel();
    });

    it("does not open the variables sidebar when a variable is typed in a native model", async () => {
      const card = createNativeCard({
        query: "SELECT * FROM PRODUCTS",
        type: "model",
      });
      setupStatefulCard({
        card,
        questionDataset: NATIVE_DATASET,
        modelDataset: NATIVE_DATASET,
      });
      await setup({
        card,
        dataset: NATIVE_DATASET,
        initialRoute: `/model/${card.id}/query`,
      });

      await typeInNativeEditor(" WHERE {{F}}");

      expect(screen.getByRole("textbox")).toHaveValue(
        "SELECT * FROM PRODUCTS WHERE {{F}}",
      );
      expect(screen.getByTestId("dataset-edit-bar")).toBeInTheDocument();
      expect(
        screen.queryByTestId("tag-editor-sidebar"),
      ).not.toBeInTheDocument();
    });

    it("opens the variables sidebar when a variable is typed in a native question", async () => {
      await setup({
        card: createMockUnsavedCard({
          dataset_query: Lib.toJsQuery(
            Lib.createTestNativeQuery(SAMPLE_PROVIDER, {
              query: "SELECT * FROM PRODUCTS",
            }),
          ),
        }),
        dataset: NATIVE_DATASET,
      });

      await typeInNativeEditor(" WHERE {{F}}");

      expect(
        await screen.findByTestId("tag-editor-sidebar"),
      ).toBeInTheDocument();
    });
  });
});

describe("QueryBuilder > creating a native model", () => {
  it("disables the columns tab until the query runs, and confirms before leaving", async () => {
    // A new model is an unsaved card that the URL marks as a model.
    const card = {
      ...createMockUnsavedCard({
        dataset_query: Lib.toJsQuery(
          Lib.createTestNativeQuery(SAMPLE_PROVIDER, { query: "" }),
        ),
      }),
      type: "model",
    };
    const { router } = await setup({
      card,
      initialRoute: `/model/query#${serializeCardForUrl(card)}`,
    });

    const editBar = await screen.findByTestId("dataset-edit-bar");
    expect(screen.getByTestId("editor-tabs-columns")).toBeDisabled();

    await userEvent.click(
      within(editBar).getByRole("button", { name: "Cancel" }),
    );
    const modal = await screen.findByTestId("leave-confirmation");
    await userEvent.click(
      within(modal).getByRole("button", { name: "Discard changes" }),
    );
    await waitFor(() => expect(router.location.pathname).toBe("/"));
  });
});

describe("QueryBuilder > questions based on a model", () => {
  const MODEL_COLUMNS = createOrdersTableDatasetColumns();
  const ORDERS_MODEL = createMockCard({
    id: 2,
    name: "Orders Model",
    type: "model",
    display: "table",
    result_metadata: MODEL_COLUMNS,
    dataset_query: Lib.toJsQuery(
      Lib.createTestQuery(SAMPLE_PROVIDER, {
        stages: [{ source: { type: "table", id: ORDERS_ID } }],
      }),
    ),
  });
  const ORDERS_MODEL_DATASET = createMockDataset({
    data: createMockDatasetData({
      cols: MODEL_COLUMNS,
      rows: [MODEL_COLUMNS.map(() => 1)],
    }),
  });
  const SAVED_QUESTION_ID = 3;

  /**
   * Saves a new card as the backend would: the created card gets an id and is
   * then served by its own endpoints.
   */
  function setupCardCreation() {
    let createdCard: Card | undefined;
    fetchMock.post("path:/api/card", (call) => {
      const body: unknown = JSON.parse(String(call.options.body));
      createdCard = createMockCard(
        Object.assign({}, body, { id: SAVED_QUESTION_ID }),
      );
      return createdCard;
    });
    fetchMock.get(`path:/api/card/${SAVED_QUESTION_ID}`, () =>
      createdCard ? createdCard : { status: 404 },
    );
    fetchMock.post(
      `path:/api/card/${SAVED_QUESTION_ID}/query`,
      ORDERS_MODEL_DATASET,
    );
    setupCardQueryMetadataEndpoint(
      createMockCard({ id: SAVED_QUESTION_ID }),
      createMockCardQueryMetadata({ databases: [TEST_DB] }),
    );
    setupListNotificationEndpoints({ card_id: SAVED_QUESTION_ID }, []);
  }

  async function setupModel() {
    setupStatefulCard({
      card: ORDERS_MODEL,
      modelDataset: ORDERS_MODEL_DATASET,
    });
    setupCardCreation();
    return setup({
      card: ORDERS_MODEL,
      initialRoute: `/model/${ORDERS_MODEL.id}`,
    });
  }

  function getCreatedCards(): unknown[] {
    return fetchMock.callHistory
      .calls("path:/api/card", { method: "POST" })
      .map((call): unknown => JSON.parse(String(call.options.body)));
  }

  function expectHeaderToShowModelSource({
    modelName = ORDERS_MODEL.name,
  }: { modelName?: string } = {}) {
    const header = screen.getByTestId("qb-header");
    expect(within(header).getAllByText("Our analytics").length).toBeGreaterThan(
      0,
    );
    expect(within(header).getByText(modelName)).toBeInTheDocument();
    expect(
      within(header).queryByText("Sample Database"),
    ).not.toBeInTheDocument();
    expect(within(header).queryByText("Orders")).not.toBeInTheDocument();
  }

  async function saveAsNewQuestion(name: string) {
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const modal = await screen.findByTestId("save-question-modal");
    expect(
      within(modal).queryByText(/Replace original question/),
    ).not.toBeInTheDocument();
    const nameInput = within(modal).getByLabelText("Name");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, name);
    await userEvent.click(within(modal).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(modal).not.toBeInTheDocument());
  }

  it("filters and summarizes a model, and saves the result as a question based on it", async () => {
    const { router } = await setupModel();

    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const popover = await screen.findByRole("dialog");
    await userEvent.click(within(popover).getByText("Discount"));
    await userEvent.type(within(popover).getByPlaceholderText("Min"), "1");
    await userEvent.click(
      within(popover).getByRole("button", { name: "Apply filter" }),
    );
    await waitFor(() => expectHeaderToShowModelSource());

    await userEvent.click(screen.getByRole("button", { name: /Summarize/ }));
    const sidebar = await screen.findByTestId("sidebar-right");
    const [createdAtItem] = within(sidebar)
      .getAllByTestId("dimension-list-item")
      .filter((item) => within(item).queryByText("Created At"));
    await userEvent.click(within(createdAtItem).getByText("Created At"));
    await userEvent.click(
      within(sidebar).getByRole("button", { name: "Done" }),
    );

    expect(
      await within(screen.getByTestId("qb-header")).findByText(
        "Count by Created At: Month",
      ),
    ).toBeInTheDocument();
    expectHeaderToShowModelSource();

    await saveAsNewQuestion("Q1");

    expect(getCreatedCards()).toHaveLength(1);
    const [createdCard] = getCreatedCards();
    expect(createdCard).toMatchObject({ name: "Q1", type: "question" });
    expect(getCreatedQuerySourceCardId(createdCard)).toBe(ORDERS_MODEL.id);
    await waitFor(() =>
      expect(router.location.pathname).toBe(
        `/question/${SAVED_QUESTION_ID}-q1`,
      ),
    );
    expect(await screen.findByDisplayValue("Q1")).toBeInTheDocument();
    await waitFor(() => expectHeaderToShowModelSource());
  });

  it("renames a model and edits its description", async () => {
    setupRevisionsEndpoints([]);
    setupUsersEndpoints([createMockUserListResult()]);
    await setupModel();

    const title = screen.getByTestId("saved-question-header-title");
    await userEvent.clear(title);
    await userEvent.type(title, "M1");
    await userEvent.tab();
    await waitFor(() =>
      expect(getCardUpdates(ORDERS_MODEL.id)).toHaveLength(1),
    );
    expect(getCardUpdates(ORDERS_MODEL.id)[0]).toMatchObject({ name: "M1" });

    await userEvent.click(screen.getByTestId("qb-header-info-button"));
    const description = await screen.findByPlaceholderText("Add description");
    await userEvent.type(description, "foo");
    await userEvent.tab();
    await waitFor(() =>
      expect(getCardUpdates(ORDERS_MODEL.id)).toHaveLength(2),
    );
    expect(getCardUpdates(ORDERS_MODEL.id)[1]).toMatchObject({
      name: "M1",
      description: "foo",
    });

    expect(screen.getByDisplayValue("M1")).toBeInTheDocument();
    expect(screen.getByText("foo")).toBeInTheDocument();
  });

  it("links a question to the archived model it is based on (metabase#52071)", async () => {
    const archivedModel = createMockCard({
      ...ORDERS_MODEL,
      name: "Accounts Model",
      archived: true,
    });
    const question = createMockCard({
      id: 5,
      name: "Accounts Model Quest",
      dataset_query: Lib.toJsQuery(
        Lib.createTestQuery(
          createMetadataProvider({
            metadata: createMockMetadata({
              databases: [TEST_DB],
              questions: [archivedModel],
            }),
          }),
          { stages: [{ source: { type: "card", id: archivedModel.id } }] },
        ),
      ),
    });
    setupCardEndpoints(archivedModel);
    // Registered before `setup` so the source model is part of the metadata.
    fetchMock.get(
      `path:/api/card/${question.id}/query_metadata`,
      createMockCardQueryMetadata({
        databases: [TEST_DB],
        cards: [archivedModel],
      }),
    );
    setupListNotificationEndpoints({ card_id: question.id }, []);
    await setup({ card: question, dataset: ORDERS_MODEL_DATASET });

    const header = screen.getByTestId("qb-header-left-side");
    expect(
      await within(header).findByRole("link", { name: /Accounts Model/ }),
    ).toHaveAttribute("href", `/model/${archivedModel.id}-accounts-model`);
    expect(within(header).getByLabelText("warning icon")).toBeInTheDocument();
  });

  it("saves a new question based on a model into the dashboard the user picked last", async () => {
    const dashboardId = 7;
    const dashboard = createMockDashboard({
      id: dashboardId,
      name: "Orders in a dashboard",
      collection_id: null,
      tabs: [],
    });
    setupDashboardEndpoints(dashboard);
    // Registered before `setup` so these routes win over its empty mocks.
    setupRecentViewsAndSelectionsEndpoints(
      [
        createMockRecentCollectionItem({
          id: dashboardId,
          model: "dashboard",
          name: dashboard.name,
          can_write: true,
        }),
      ],
      ["selections"],
    );
    fetchMock.post(
      "path:/api/dataset/query_metadata",
      createMockCardQueryMetadata({
        databases: [TEST_DB],
        cards: [ORDERS_MODEL],
      }),
    );
    setupStatefulCard({
      card: ORDERS_MODEL,
      modelDataset: ORDERS_MODEL_DATASET,
    });
    setupCardCreation();
    const { router } = await setup({
      card: createMockUnsavedCard({
        dataset_query: Lib.toJsQuery(
          Lib.createTestQuery(
            createMetadataProvider({
              metadata: createMockMetadata({
                databases: [TEST_DB],
                questions: [ORDERS_MODEL],
              }),
            }),
            { stages: [{ source: { type: "card", id: ORDERS_MODEL.id } }] },
          ),
        ),
      }),
    });

    await waitFor(() => expectHeaderToShowModelSource());
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const modal = await screen.findByTestId("save-question-modal");
    await waitFor(() =>
      expect(
        within(modal).getByLabelText("Where do you want to save this?"),
      ).toHaveTextContent(dashboard.name),
    );
    await userEvent.click(within(modal).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(getCreatedCards()).toHaveLength(1));
    const [createdCard] = getCreatedCards();
    expect(createdCard).toMatchObject({ dashboard_id: dashboard.id });
    expect(getCreatedQuerySourceCardId(createdCard)).toBe(ORDERS_MODEL.id);
    await waitFor(() =>
      expect(router.location.pathname).toMatch(
        new RegExp(`^/dashboard/${dashboard.id}-[a-z0-9-]*$`),
      ),
    );
  });

  it("filters a native model and saves the result as a question based on it", async () => {
    const nativeColumns = [
      createMockColumn({
        id: undefined,
        table_id: undefined,
        name: "ID",
        display_name: "ID",
        base_type: "type/BigInteger",
        effective_type: "type/BigInteger",
        semantic_type: "type/PK",
        field_ref: ["field", "ID", { "base-type": "type/BigInteger" }],
      }),
      createMockColumn({
        id: undefined,
        table_id: undefined,
        name: "PRICE",
        display_name: "PRICE",
        base_type: "type/Float",
        effective_type: "type/Float",
        field_ref: ["field", "PRICE", { "base-type": "type/Float" }],
      }),
    ];
    const nativeModel = createMockCard({
      id: ORDERS_MODEL.id,
      name: "Product Model",
      type: "model",
      display: "table",
      query_type: "native",
      result_metadata: nativeColumns,
      dataset_query: Lib.toJsQuery(
        Lib.createTestNativeQuery(SAMPLE_PROVIDER, {
          query: "SELECT * FROM PRODUCTS",
        }),
      ),
    });
    setupStatefulCard({
      card: nativeModel,
      modelDataset: createMockDataset({
        data: createMockDatasetData({ cols: nativeColumns, rows: [[1, 10]] }),
      }),
    });
    setupCardCreation();
    const { router } = await setup({
      card: nativeModel,
      initialRoute: `/model/${nativeModel.id}`,
    });

    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const popover = await screen.findByRole("dialog");
    await userEvent.click(within(popover).getByText("PRICE"));
    await userEvent.type(within(popover).getByPlaceholderText("Min"), "1");
    await userEvent.click(
      within(popover).getByRole("button", { name: "Apply filter" }),
    );
    await waitFor(() =>
      expectHeaderToShowModelSource({ modelName: "Product Model" }),
    );

    await saveAsNewQuestion("Q1");

    const [createdCard] = getCreatedCards();
    expect(createdCard).toMatchObject({ name: "Q1", type: "question" });
    expect(getCreatedQuerySourceCardId(createdCard)).toBe(nativeModel.id);
    await waitFor(() =>
      expect(router.location.pathname).toBe(
        `/question/${SAVED_QUESTION_ID}-q1`,
      ),
    );
  });

  it("creates a question from a model with a column action, and saves it as a question based on the model", async () => {
    // Gives the virtualized table a size, so that it renders its columns.
    mockGetBoundingClientRect();
    const { router } = await setupModel();

    await userEvent.click(
      within(await screen.findByTestId("table-header")).getByText("Subtotal"),
    );
    await userEvent.click(await screen.findByText("Sum over time"));

    expect(
      await within(screen.getByTestId("qb-header")).findByText(
        "Sum of Subtotal by Created At: Month",
      ),
    ).toBeInTheDocument();
    expectHeaderToShowModelSource();

    await saveAsNewQuestion("Q2");

    const [createdCard] = getCreatedCards();
    expect(createdCard).toMatchObject({ name: "Q2", type: "question" });
    expect(getCreatedQuerySourceCardId(createdCard)).toBe(ORDERS_MODEL.id);
    await waitFor(() =>
      expect(router.location.pathname).toBe(
        `/question/${SAVED_QUESTION_ID}-q2`,
      ),
    );
    await waitFor(() => expectHeaderToShowModelSource());
  });
});

/**
 * Pastes the whole text at once, like the real editor that closes the braces
 * of a variable as it is typed: a half-typed `{{` is not a valid query.
 */
async function typeInNativeEditor(text: string) {
  const editor = await screen.findByTestId("mock-native-query-editor");
  const textbox = within(editor).getByRole("textbox");
  await userEvent.click(textbox);
  await userEvent.paste(text);
  await userEvent.tab();
}
