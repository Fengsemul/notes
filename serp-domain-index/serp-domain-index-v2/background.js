"use strict";

const api = globalThis.browser ?? globalThis.chrome;

const META_DB_NAME = "serp-domain-label-meta-v2";
const META_DB_VERSION = 1;
const META_STORE = "metadata";

const STATE_KEY = "state";
const IMPORT_KEY = "import-state";
const GENERATIONS_KEY = "known-generations";

const GENERATION_DB_PREFIX =
  "serp-domain-label-generation-v2-";
const GENERATION_DB_VERSION = 1;
const LABEL_STORE = "labels";

const LOOKUP_REQUEST_LIMIT = 256;
const IMPORT_BATCH_LIMIT = 5000;
const LOOKUP_CACHE_LIMIT = 20000;
const MAX_LABEL_LENGTH = 63;
const MAX_SOURCE_COUNT = 100;
const MAX_REJECTION_SAMPLES = 20;

const DEFAULT_PROTECTED_LABELS = Object.freeze([
  "www",
  "www1",
  "www2",
  "www3",
  "m"
]);

const DEFAULT_STATE = Object.freeze({
  activeGeneration: null,
  previousGeneration: null,
  count: 0,
  enabled: true,
  revision: 0,
  importedAt: null,
  protectedLabels: [...DEFAULT_PROTECTED_LABELS]
});

let metaDatabasePromise = null;
let state = { ...DEFAULT_STATE };
let stateLoaded = false;
let initializationPromise = null;

const generationDatabasePromises = new Map();

class LruCache {
  constructor(limit) {
    this.limit = limit;
    this.values = new Map();
  }

  get(key) {
    if (!this.values.has(key)) {
      return undefined;
    }

    const value = this.values.get(key);
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.values.has(key)) {
      this.values.delete(key);
    }

    this.values.set(key, value);

    if (this.values.size > this.limit) {
      const oldestKey =
        this.values.keys().next().value;
      this.values.delete(oldestKey);
    }
  }

  clear() {
    this.values.clear();
  }
}

const lookupCache = new LruCache(
  LOOKUP_CACHE_LIMIT
);

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(
        request.error ??
          new Error(
            "An IndexedDB request failed."
          )
      );
    };
  });
}

function transactionAsPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };

    transaction.onerror = () => {
      reject(
        transaction.error ??
          new Error(
            "An IndexedDB transaction failed."
          )
      );
    };

    transaction.onabort = () => {
      reject(
        transaction.error ??
          new Error(
            "An IndexedDB transaction was aborted."
          )
      );
    };
  });
}

function openMetaDatabase() {
  if (metaDatabasePromise) {
    return metaDatabasePromise;
  }

  metaDatabasePromise = new Promise(
    (resolve, reject) => {
      const request = indexedDB.open(
        META_DB_NAME,
        META_DB_VERSION
      );

      request.onupgradeneeded = () => {
        const database = request.result;

        if (
          !database.objectStoreNames.contains(
            META_STORE
          )
        ) {
          database.createObjectStore(
            META_STORE
          );
        }
      };

      request.onsuccess = () => {
        const database = request.result;

        database.onversionchange = () => {
          database.close();
          metaDatabasePromise = null;
        };

        resolve(database);
      };

      request.onerror = () => {
        metaDatabasePromise = null;

        reject(
          request.error ??
            new Error(
              "Could not open the metadata database."
            )
        );
      };

      request.onblocked = () => {
        metaDatabasePromise = null;

        reject(
          new Error(
            "Opening the metadata database was blocked."
          )
        );
      };
    }
  );

  return metaDatabasePromise;
}

async function readMetadata(key) {
  const database =
    await openMetaDatabase();

  const transaction =
    database.transaction(
      META_STORE,
      "readonly"
    );

  const request = transaction
    .objectStore(META_STORE)
    .get(key);

  const value =
    await requestAsPromise(request);

  await transactionAsPromise(transaction);

  return value;
}

async function writeMetadata(key, value) {
  const database =
    await openMetaDatabase();

  const transaction =
    database.transaction(
      META_STORE,
      "readwrite"
    );

  transaction
    .objectStore(META_STORE)
    .put(value, key);

  await transactionAsPromise(transaction);
}

async function deleteMetadata(key) {
  const database =
    await openMetaDatabase();

  const transaction =
    database.transaction(
      META_STORE,
      "readwrite"
    );

  transaction
    .objectStore(META_STORE)
    .delete(key);

  await transactionAsPromise(transaction);
}

function validateGeneration(value) {
  const generation = Number(value);

  if (
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    throw new Error(
      "Invalid database generation."
    );
  }

  return generation;
}

function generationDatabaseName(generation) {
  return (
    GENERATION_DB_PREFIX +
    validateGeneration(generation)
  );
}

function openGenerationDatabase(generation) {
  const validGeneration =
    validateGeneration(generation);

  if (
    generationDatabasePromises.has(
      validGeneration
    )
  ) {
    return generationDatabasePromises.get(
      validGeneration
    );
  }

  const promise = new Promise(
    (resolve, reject) => {
      const request = indexedDB.open(
        generationDatabaseName(
          validGeneration
        ),
        GENERATION_DB_VERSION
      );

      request.onupgradeneeded = () => {
        const database = request.result;

        if (
          !database.objectStoreNames.contains(
            LABEL_STORE
          )
        ) {
          database.createObjectStore(
            LABEL_STORE
          );
        }
      };

      request.onsuccess = () => {
        const database = request.result;

        database.onversionchange = () => {
          database.close();
          generationDatabasePromises.delete(
            validGeneration
          );
        };

        resolve(database);
      };

      request.onerror = () => {
        generationDatabasePromises.delete(
          validGeneration
        );

        reject(
          request.error ??
            new Error(
              "Could not open generation " +
                validGeneration +
                "."
            )
        );
      };

      request.onblocked = () => {
        generationDatabasePromises.delete(
          validGeneration
        );

        reject(
          new Error(
            "Opening generation " +
              validGeneration +
              " was blocked."
          )
        );
      };
    }
  );

  generationDatabasePromises.set(
    validGeneration,
    promise
  );

  return promise;
}

async function closeGenerationDatabase(
  generation
) {
  const validGeneration =
    validateGeneration(generation);

  const promise =
    generationDatabasePromises.get(
      validGeneration
    );

  generationDatabasePromises.delete(
    validGeneration
  );

  if (!promise) {
    return;
  }

  try {
    const database = await promise;
    database.close();
  } catch {
    // A failed database needs no closing.
  }
}

function deleteDatabaseRequest(name) {
  return new Promise((resolve, reject) => {
    const request =
      indexedDB.deleteDatabase(name);

    request.onsuccess = () => {
      resolve({
        deleted: true,
        blocked: false
      });
    };

    request.onblocked = () => {
      resolve({
        deleted: false,
        blocked: true
      });
    };

    request.onerror = () => {
      reject(
        request.error ??
          new Error(
            "Could not delete database " +
              name +
              "."
          )
      );
    };
  });
}

async function readKnownGenerations() {
  const stored = await readMetadata(
    GENERATIONS_KEY
  );

  if (!Array.isArray(stored)) {
    return [];
  }

  return [
    ...new Set(
      stored.filter(
        (value) =>
          Number.isSafeInteger(value) &&
          value >= 1
      )
    )
  ].sort((left, right) => left - right);
}

async function writeKnownGenerations(
  generations
) {
  const normalized = [
    ...new Set(
      generations.filter(
        (value) =>
          Number.isSafeInteger(value) &&
          value >= 1
      )
    )
  ].sort((left, right) => left - right);

  await writeMetadata(
    GENERATIONS_KEY,
    normalized
  );
}

async function registerGeneration(
  generation
) {
  const validGeneration =
    validateGeneration(generation);

  const known =
    await readKnownGenerations();

  if (!known.includes(validGeneration)) {
    known.push(validGeneration);
    await writeKnownGenerations(known);
  }
}

async function unregisterGeneration(
  generation
) {
  const validGeneration =
    validateGeneration(generation);

  const known =
    await readKnownGenerations();

  await writeKnownGenerations(
    known.filter(
      (value) =>
        value !== validGeneration
    )
  );
}

async function deleteGenerationDatabase(
  generation
) {
  const validGeneration =
    validateGeneration(generation);

  if (
    validGeneration ===
      state.activeGeneration ||
    validGeneration ===
      state.previousGeneration
  ) {
    throw new Error(
      "A retained generation cannot be deleted."
    );
  }

  await closeGenerationDatabase(
    validGeneration
  );

  const result = await deleteDatabaseRequest(
    generationDatabaseName(
      validGeneration
    )
  );

  if (result.blocked) {
    throw new Error(
      "Deleting generation " +
        validGeneration +
        " is blocked."
    );
  }

  if (result.deleted) {
    await unregisterGeneration(
      validGeneration
    );
  }

  return result;
}

async function writeLabelBatch(
  generation,
  labels
) {
  if (labels.length === 0) {
    return;
  }

  const database =
    await openGenerationDatabase(
      generation
    );

  const transaction =
    database.transaction(
      LABEL_STORE,
      "readwrite"
    );

  const store =
    transaction.objectStore(
      LABEL_STORE
    );

  for (const label of labels) {
    store.put(1, label);
  }

  await transactionAsPromise(transaction);
}

async function countGeneration(generation) {
  const database =
    await openGenerationDatabase(
      generation
    );

  const transaction =
    database.transaction(
      LABEL_STORE,
      "readonly"
    );

  const request = transaction
    .objectStore(LABEL_STORE)
    .count();

  const count =
    await requestAsPromise(request);

  await transactionAsPromise(transaction);

  return count;
}

async function generationContainsLabel(
  generation,
  label
) {
  const database =
    await openGenerationDatabase(
      generation
    );

  const transaction =
    database.transaction(
      LABEL_STORE,
      "readonly"
    );

  const request = transaction
    .objectStore(LABEL_STORE)
    .getKey(label);

  const key =
    await requestAsPromise(request);

  await transactionAsPromise(transaction);

  return key !== undefined;
}

function normalizeLabel(value) {
  let label = String(value)
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase();

  if (!label) {
    return "";
  }

  if (label.startsWith("*://*.")) {
    label = label.slice(6);
  } else if (label.startsWith("*://")) {
    label = label.slice(4);
    label = label.replace(/^\*\./, "");
  }

  if (label.endsWith("/*")) {
    label = label.slice(0, -2);
  }

  label = label
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");

  if (
    label.includes("/") ||
    label.includes("\\") ||
    label.includes(":") ||
    label.includes("?") ||
    label.includes("#") ||
    label.includes("*") ||
    label.includes("|") ||
    label.includes("^") ||
    label.includes(".")
  ) {
    return "";
  }

  if (
    label.length === 0 ||
    label.length > MAX_LABEL_LENGTH
  ) {
    return "";
  }

  if (
    !/^[a-z0-9_-]+$/.test(label) ||
    label.startsWith("-") ||
    label.endsWith("-")
  ) {
    return "";
  }

  return label;
}

function normalizeProtectedLabels(values) {
  const source = Array.isArray(values)
    ? values
    : DEFAULT_PROTECTED_LABELS;

  const normalized = new Set();

  for (const value of source) {
    const label = normalizeLabel(value);

    if (label) {
      normalized.add(label);
    }
  }

  return [...normalized].sort();
}

function normalizeHostname(value) {
  let hostname = String(value)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");

  if (!hostname) {
    return "";
  }

  try {
    hostname = new URL(
      "http://" + hostname
    ).hostname
      .toLowerCase()
      .replace(/\.$/, "");
  } catch {
    return "";
  }

  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    hostname.includes(":") ||
    !hostname.includes(".")
  ) {
    return "";
  }

  const labels = hostname.split(".");

  if (labels.length < 2) {
    return "";
  }

  for (const label of labels) {
    if (
      label.length === 0 ||
      label.length > MAX_LABEL_LENGTH ||
      !/^[a-z0-9_-]+$/.test(label) ||
      label.startsWith("-") ||
      label.endsWith("-")
    ) {
      return "";
    }
  }

  return hostname;
}

async function ensureStateLoaded() {
  if (stateLoaded) {
    return;
  }

  const stored = await readMetadata(
    STATE_KEY
  );

  state = {
    ...DEFAULT_STATE,
    ...(
      stored &&
      typeof stored === "object" &&
      !Array.isArray(stored)
        ? stored
        : {}
    )
  };

  if (
    !Number.isSafeInteger(
      state.activeGeneration
    ) ||
    state.activeGeneration < 1
  ) {
    state.activeGeneration = null;
    state.count = 0;
  }

  if (
    !Number.isSafeInteger(
      state.previousGeneration
    ) ||
    state.previousGeneration < 1 ||
    state.previousGeneration ===
      state.activeGeneration
  ) {
    state.previousGeneration = null;
  }

  state.enabled =
    state.enabled !== false;

  state.revision =
    Number.isSafeInteger(
      state.revision
    ) &&
    state.revision >= 0
      ? state.revision
      : 0;

  state.count =
    Number.isSafeInteger(state.count) &&
    state.count >= 0
      ? state.count
      : 0;

  state.protectedLabels =
    normalizeProtectedLabels(
      state.protectedLabels
    );

  stateLoaded = true;
}

async function ensureInitialized() {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    if (
      !globalThis.PublicSuffixData ||
      typeof globalThis.PublicSuffixData
        .load !== "function"
    ) {
      throw new Error(
        "The Public Suffix List parser is unavailable."
      );
    }

    const publicSuffixStatus =
      await globalThis.PublicSuffixData.load();

    if (
      publicSuffixStatus?.loaded !== true ||
      !Number.isSafeInteger(
        publicSuffixStatus.ruleCount
      ) ||
      publicSuffixStatus.ruleCount < 1000
    ) {
      throw new Error(
        "The bundled Public Suffix List did not load correctly."
      );
    }

    await ensureStateLoaded();
  })();

  try {
    await initializationPromise;
  } catch (error) {
    initializationPromise = null;
    throw error;
  }
}

function publicSuffixLabelCount(
  hostname
) {
  const labels = hostname.split(".");

  if (
    !globalThis.PublicSuffixData ||
    typeof globalThis.PublicSuffixData
      .getPublicSuffixLabelCount !==
      "function"
  ) {
    return 1;
  }

  const count =
    globalThis.PublicSuffixData
      .getPublicSuffixLabelCount(labels);

  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count >= labels.length
  ) {
    return 1;
  }

  return count;
}

function hostnameLabelsToCheck(
  hostname
) {
  const normalized =
    normalizeHostname(hostname);

  if (!normalized) {
    return [];
  }

  const labels = normalized.split(".");
  const suffixCount =
    publicSuffixLabelCount(normalized);

  const protectedSet = new Set(
    state.protectedLabels
  );

  return labels
    .slice(
      0,
      labels.length - suffixCount
    )
    .filter(
      (label) =>
        !protectedSet.has(label)
    );
}

async function exactLabelIsBlocked(
  label
) {
  await ensureInitialized();

  if (
    !state.enabled ||
    !state.activeGeneration
  ) {
    return false;
  }

  const normalized =
    normalizeLabel(label);

  if (
    !normalized ||
    state.protectedLabels.includes(
      normalized
    )
  ) {
    return false;
  }

  const cacheKey =
    state.revision +
    ":" +
    state.activeGeneration +
    ":" +
    normalized;

  const cached =
    lookupCache.get(cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  const found =
    await generationContainsLabel(
      state.activeGeneration,
      normalized
    );

  lookupCache.set(cacheKey, found);

  return found;
}

async function hostnameIsBlocked(
  hostname
) {
  const labels =
    hostnameLabelsToCheck(hostname);

  for (const label of labels) {
    if (
      await exactLabelIsBlocked(label)
    ) {
      return true;
    }
  }

  return false;
}

async function lookupHostnames(values) {
  await ensureInitialized();

  const input = Array.isArray(values)
    ? values.slice(
        0,
        LOOKUP_REQUEST_LIMIT
      )
    : [];

  const results =
    new Array(input.length).fill(false);

  const positions = new Map();
  const uniqueHostnames = [];

  for (
    let index = 0;
    index < input.length;
    index++
  ) {
    const hostname =
      normalizeHostname(input[index]);

    if (!hostname) {
      continue;
    }

    if (!positions.has(hostname)) {
      positions.set(hostname, []);
      uniqueHostnames.push(hostname);
    }

    positions.get(hostname).push(index);
  }

  for (const hostname of uniqueHostnames) {
    const blocked =
      await hostnameIsBlocked(hostname);

    for (
      const index of positions.get(
        hostname
      )
    ) {
      results[index] = blocked;
    }
  }

  return results;
}

function notifyFilteringChanged() {
  try {
    const operation =
      api.runtime.sendMessage({
        type: "filter-state-changed",
        generation:
          state.activeGeneration,
        revision: state.revision
      });

    if (
      operation &&
      typeof operation.catch ===
        "function"
    ) {
      operation.catch(() => {});
    }
  } catch {
    // No content script may be listening.
  }
}

function normalizeReasonMap(value) {
  const output = {};

  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return output;
  }

  for (
    const [reason, countValue] of
      Object.entries(value)
  ) {
    const count = Number(countValue);

    if (
      reason &&
      Number.isSafeInteger(count) &&
      count >= 0
    ) {
      output[
        String(reason).slice(0, 100)
      ] = count;
    }
  }

  return output;
}

function normalizeSamples(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) =>
      String(value).slice(0, 300)
    )
    .filter(Boolean)
    .slice(0, MAX_REJECTION_SAMPLES);
}

function publicImportState(importState) {
  if (!importState) {
    return null;
  }

  return {
    status: importState.status,
    importId: importState.importId,
    generation:
      importState.generation,
    expectedSourceCount:
      importState.expectedSourceCount,
    completedSources:
      importState.completedSources,
    currentSource:
      importState.currentSource,
    currentSourceName:
      importState.currentSourceName ?? "",
    sourceNames: Array.isArray(
      importState.sourceNames
    )
      ? [...importState.sourceNames]
      : [],
    completedSourceNames:
      Array.isArray(
        importState.completedSourceNames
      )
        ? [
            ...importState
              .completedSourceNames
          ]
        : [],
    sourceMetadata:
      importState.sourceMetadata &&
      typeof importState.sourceMetadata ===
        "object"
        ? { ...importState.sourceMetadata }
        : {},
    batches: importState.batches,
    received: importState.received,
    accepted: importState.accepted,
    rejected: importState.rejected,
    rejectionReasons:
      normalizeReasonMap(
        importState.rejectionReasons
      ),
    rejectionSamples:
      normalizeSamples(
        importState.rejectionSamples
      ),
    startedAt: importState.startedAt,
    updatedAt: importState.updatedAt
  };
}

function pslStatus() {
  if (
    !globalThis.PublicSuffixData ||
    typeof globalThis.PublicSuffixData
      .getStatus !== "function"
  ) {
    return {
      loaded: false,
      version: "unavailable",
      ruleCount: 0
    };
  }

  return globalThis.PublicSuffixData
    .getStatus();
}

function publicStatus(
  importState = null
) {
  const resumable =
    importState?.status === "building";

  return {
    enabled: state.enabled,
    active: Boolean(
      state.activeGeneration
    ),
    count: state.count,
    generation:
      state.activeGeneration,
    previousGeneration:
      state.previousGeneration,
    revision: state.revision,
    importedAt: state.importedAt,
    protectedLabels: [
      ...state.protectedLabels
    ],
    publicSuffix: pslStatus(),
    importRunning: false,
    interruptedImport: resumable,
    resumableImport: resumable,
    importState:
      publicImportState(importState),
    sourceCount:
      importState?.expectedSourceCount ??
      0
  };
}

async function getStatus() {
  await ensureInitialized();

  const importState =
    await readMetadata(IMPORT_KEY);

  return publicStatus(
    importState ?? null
  );
}

async function updateSettings(message) {
  await ensureInitialized();

  if (
    typeof message.enabled === "boolean"
  ) {
    state.enabled = message.enabled;
  }

  if (
    Array.isArray(
      message.protectedLabels
    )
  ) {
    state.protectedLabels =
      normalizeProtectedLabels(
        message.protectedLabels
      );
  }

  state = {
    ...state,
    revision: state.revision + 1
  };

  await writeMetadata(
    STATE_KEY,
    state
  );

  lookupCache.clear();
  notifyFilteringChanged();

  return getStatus();
}

function validateImportId(
  importState,
  importId
) {
  if (
    !importState ||
    importState.status !== "building" ||
    typeof importId !== "string" ||
    importState.importId !== importId
  ) {
    throw new Error(
      "No matching import session is active."
    );
  }
}

function validateSourceCount(value) {
  const count = Number(value);

  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_SOURCE_COUNT
  ) {
    throw new Error(
      "Invalid expected source count."
    );
  }

  return count;
}

function validateSourceNames(
  values,
  expectedCount
) {
  if (
    !Array.isArray(values) ||
    values.length !== expectedCount
  ) {
    throw new Error(
      "The source-name list is incomplete."
    );
  }

  const names = values.map(
    (value) => String(value).trim()
  );

  if (
    names.some(
      (name) =>
        !name ||
        name.length > 128 ||
        /[\\/\u0000]/.test(name)
    )
  ) {
    throw new Error(
      "The source list contains an invalid name."
    );
  }

  if (
    new Set(names).size !== names.length
  ) {
    throw new Error(
      "The source list contains duplicate names."
    );
  }

  return names;
}

async function allocateGeneration() {
  const known =
    await readKnownGenerations();

  const importState =
    await readMetadata(IMPORT_KEY);

  const candidates = [
    ...known,
    state.activeGeneration,
    state.previousGeneration,
    importState?.generation,
    Date.now()
  ].filter(
    (value) =>
      Number.isSafeInteger(value) &&
      value >= 1
  );
  let generation =
    Math.max(0, ...candidates) + 1;

  while (known.includes(generation)) {
    generation++;
  }

  return generation;
}

async function beginImport(message) {
  await ensureInitialized();

  const existingImport =
    await readMetadata(IMPORT_KEY);

  if (
    existingImport?.status ===
      "building"
  ) {
    throw new Error(
      "A resumable import already exists."
    );
  }

  const importId = String(
    message.importId ?? ""
  ).trim();

  if (
    !/^[a-zA-Z0-9_-]{8,128}$/.test(
      importId
    )
  ) {
    throw new Error(
      "Invalid import ID."
    );
  }

  const expectedSourceCount =
    validateSourceCount(
      message.expectedSourceCount
    );

  const sourceNames =
    validateSourceNames(
      message.sourceNames,
      expectedSourceCount
    );

  const generation =
    await allocateGeneration();

  await openGenerationDatabase(
    generation
  );

  await registerGeneration(
    generation
  );

  const now =
    new Date().toISOString();

  const importState = {
    status: "building",
    importId,
    generation,
    expectedSourceCount,
    sourceNames,
    completedSources: 0,
    completedSourceNames: [],
    currentSource: 1,
    currentSourceName:
      sourceNames[0] ?? "",
    sourceMetadata: {},
    batches: 0,
    received: 0,
    accepted: 0,
    rejected: 0,
    rejectionReasons: {},
    rejectionSamples: [],
    startedAt: now,
    updatedAt: now
  };

  await writeMetadata(
    IMPORT_KEY,
    importState
  );

  return {
    importId,
    generation,
    status: publicStatus(importState)
  };
}

async function resumeImport(message) {
  await ensureInitialized();

  const importState =
    await readMetadata(IMPORT_KEY);

  if (
    !importState ||
    importState.status !== "building"
  ) {
    throw new Error(
      "No resumable import exists."
    );
  }

  const expectedSourceCount =
    validateSourceCount(
      message.expectedSourceCount
    );

  const sourceNames =
    validateSourceNames(
      message.sourceNames,
      expectedSourceCount
    );

  if (
    importState.expectedSourceCount !==
      expectedSourceCount ||
    JSON.stringify(
      importState.sourceNames
    ) !== JSON.stringify(sourceNames)
  ) {
    throw new Error(
      "The saved import uses a different source configuration."
    );
  }

  await openGenerationDatabase(
    importState.generation
  );

  const nextSource = Math.min(
    importState.completedSources + 1,
    importState.expectedSourceCount
  );

  importState.currentSource =
    nextSource;

  importState.currentSourceName =
    importState.sourceNames[
      nextSource - 1
    ] ?? "";

  importState.updatedAt =
    new Date().toISOString();

  await writeMetadata(
    IMPORT_KEY,
    importState
  );

  return {
    importId: importState.importId,
    generation:
      importState.generation,
    nextSource,
    completedSources:
      importState.completedSources,
    status: publicStatus(importState)
  };
}

async function appendImportBatch(
  message
) {
  await ensureInitialized();

  const importState =
    await readMetadata(IMPORT_KEY);

  validateImportId(
    importState,
    message.importId
  );

  const sourceIndex = Number(
    message.sourceIndex
  );

  if (
    !Number.isInteger(sourceIndex) ||
    sourceIndex < 1 ||
    sourceIndex >
      importState.expectedSourceCount ||
    sourceIndex !==
      importState.completedSources + 1
  ) {
    throw new Error(
      "The batch does not belong to the next incomplete source."
    );
  }

  const expectedSourceName =
    importState.sourceNames[
      sourceIndex - 1
    ];

  if (
    String(message.sourceName ?? "") !==
    expectedSourceName
  ) {
    throw new Error(
      "The batch source name does not match."
    );
  }

  const values =
    Array.isArray(message.labels)
      ? message.labels.slice(
          0,
          IMPORT_BATCH_LIMIT
        )
      : [];

  const uniqueLabels = new Set();

  for (const value of values) {
    const label = normalizeLabel(value);

    if (label) {
      uniqueLabels.add(label);
    }
  }

  const labels =
    Array.from(uniqueLabels);

  await writeLabelBatch(
    importState.generation,
    labels
  );

  importState.batches =
    Number(importState.batches ?? 0) +
    1;

  importState.received =
    Number(importState.received ?? 0) +
    values.length;

  importState.accepted =
    Number(importState.accepted ?? 0) +
    labels.length;

  importState.currentSource =
    sourceIndex;

  importState.currentSourceName =
    expectedSourceName;

  importState.updatedAt =
    new Date().toISOString();

  await writeMetadata(
    IMPORT_KEY,
    importState
  );

  return {
    accepted: labels.length,
    received: values.length,
    batches: importState.batches,
    generation:
      importState.generation
  };
}

async function recordRejections(
  message
) {
  await ensureInitialized();

  const importState =
    await readMetadata(IMPORT_KEY);

  validateImportId(
    importState,
    message.importId
  );

  const sourceIndex = Number(
    message.sourceIndex
  );

  if (
    !Number.isInteger(sourceIndex) ||
    sourceIndex < 1 ||
    sourceIndex >
      importState.expectedSourceCount ||
    sourceIndex !==
      importState.completedSources + 1
  ) {
    throw new Error(
      "The rejection report has an invalid source index."
    );
  }

  const expectedSourceName =
    importState.sourceNames[
      sourceIndex - 1
    ];

  if (
    String(message.sourceName ?? "") !==
    expectedSourceName
  ) {
    throw new Error(
      "The rejection-report source name does not match."
    );
  }

  const count = Number(
    message.count ?? 0
  );

  if (
    !Number.isSafeInteger(count) ||
    count < 0
  ) {
    throw new Error(
      "Invalid rejection count."
    );
  }

  const reasons =
    normalizeReasonMap(
      message.reasons
    );

  importState.rejected =
    Number(importState.rejected ?? 0) +
    count;

  importState.rejectionReasons =
    normalizeReasonMap(
      importState.rejectionReasons
    );

  for (
    const [reason, reasonCount] of
      Object.entries(reasons)
  ) {
    importState.rejectionReasons[
      reason
    ] =
      Number(
        importState.rejectionReasons[
          reason
        ] ?? 0
      ) + reasonCount;
  }

  const existingSamples =
    normalizeSamples(
      importState.rejectionSamples
    );

  const newSamples =
    normalizeSamples(message.samples);

  importState.rejectionSamples =
    [...existingSamples];

  for (const sample of newSamples) {
    if (
      importState.rejectionSamples
        .length >= MAX_REJECTION_SAMPLES
    ) {
      break;
    }

    if (
      !importState.rejectionSamples
        .includes(sample)
    ) {
      importState.rejectionSamples.push(
        sample
      );
    }
  }

  importState.updatedAt =
    new Date().toISOString();

  await writeMetadata(
    IMPORT_KEY,
    importState
  );

  return {
    rejected: importState.rejected,
    rejectionReasons:
      importState.rejectionReasons,
    rejectionSamples:
      importState.rejectionSamples
  };
}

async function completeImportSource(
  message
) {
  await ensureInitialized();

  const importState =
    await readMetadata(IMPORT_KEY);

  validateImportId(
    importState,
    message.importId
  );

  const sourceIndex = Number(
    message.sourceIndex
  );

  if (
    !Number.isInteger(sourceIndex) ||
    sourceIndex < 1 ||
    sourceIndex >
      importState.expectedSourceCount
  ) {
    throw new Error(
      "Invalid source index."
    );
  }

  if (
    sourceIndex !==
    importState.completedSources + 1
  ) {
    throw new Error(
      "Sources must complete in order."
    );
  }

  const sourceName =
    importState.sourceNames[
      sourceIndex - 1
    ];

  if (
    String(message.sourceName ?? "") !==
    sourceName
  ) {
    throw new Error(
      "The completed source name does not match."
    );
  }

  const byteLength = Number(
    message.byteLength ?? 0
  );

  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1
  ) {
    throw new Error(
      "The source byte length is invalid."
    );
  }

  const lineCount = Number(
    message.lineCount ?? 0
  );

  if (
    !Number.isSafeInteger(lineCount) ||
    lineCount < 1
  ) {
    throw new Error(
      "The source line count is invalid."
    );
  }

  const acceptedCount = Number(
    message.acceptedCount ?? 0
  );

  const rejectedCount = Number(
    message.rejectedCount ?? 0
  );

  if (
    !Number.isSafeInteger(
      acceptedCount
    ) ||
    acceptedCount < 0 ||
    !Number.isSafeInteger(
      rejectedCount
    ) ||
    rejectedCount < 0 ||
    acceptedCount + rejectedCount !==
      lineCount
  ) {
    throw new Error(
      "The source import counts are inconsistent."
    );
  }

  const etag =
    typeof message.etag === "string"
      ? message.etag.slice(0, 500)
      : "";

  const lastModified =
    typeof message.lastModified ===
      "string"
      ? message.lastModified.slice(
          0,
          500
        )
      : "";

  importState.sourceMetadata =
    importState.sourceMetadata &&
    typeof importState.sourceMetadata ===
      "object"
      ? importState.sourceMetadata
      : {};

  importState.sourceMetadata[
    sourceName
  ] = {
    byteLength,
    lineCount,
    acceptedCount,
    rejectedCount,
    etag,
    lastModified,
    completedAt:
      new Date().toISOString()
  };

  importState.completedSources =
    sourceIndex;

  importState.completedSourceNames =
    Array.isArray(
      importState.completedSourceNames
    )
      ? importState.completedSourceNames
      : [];

  if (
    !importState.completedSourceNames
      .includes(sourceName)
  ) {
    importState.completedSourceNames.push(
      sourceName
    );
  }

  const nextSource = Math.min(
    sourceIndex + 1,
    importState.expectedSourceCount
  );

  importState.currentSource =
    nextSource;

  importState.currentSourceName =
    sourceIndex <
    importState.expectedSourceCount
      ? importState.sourceNames[
          nextSource - 1
        ]
      : "";

  importState.updatedAt =
    new Date().toISOString();

  await writeMetadata(
    IMPORT_KEY,
    importState
  );

  return {
    completedSources:
      importState.completedSources,
    completedSourceNames: [
      ...importState
        .completedSourceNames
    ],
    sourceCount:
      importState.expectedSourceCount,
    nextSource,
    currentSourceName:
      importState.currentSourceName,
    sourceMetadata:
      importState.sourceMetadata[
        sourceName
      ]
  };
}

async function finishImport(message) {
  await ensureInitialized();

  const importState =
    await readMetadata(IMPORT_KEY);

  validateImportId(
    importState,
    message.importId
  );

  if (
    importState.completedSources !==
      importState.expectedSourceCount ||
    !Array.isArray(
      importState.completedSourceNames
    ) ||
    importState.completedSourceNames
      .length !==
      importState.expectedSourceCount
  ) {
    throw new Error(
      "All configured sources must complete before activation."
    );
  }

  for (
    const sourceName of
      importState.sourceNames
  ) {
    const metadata =
      importState.sourceMetadata?.[
        sourceName
      ];

    if (
      !metadata ||
      !Number.isSafeInteger(
        metadata.byteLength
      ) ||
      metadata.byteLength < 1 ||
      !Number.isSafeInteger(
        metadata.lineCount
      ) ||
      metadata.lineCount < 1
    ) {
      throw new Error(
        "Verification metadata is missing for " +
          sourceName +
          "."
      );
    }
  }

  const exactCount =
    await countGeneration(
      importState.generation
    );

  if (exactCount < 1) {
    throw new Error(
      "The replacement label index is empty."
    );
  }

  const oldActiveGeneration =
    state.activeGeneration;

  const oldPreviousGeneration =
    state.previousGeneration;

  const nextState = {
    ...state,
    activeGeneration:
      importState.generation,
    previousGeneration:
      oldActiveGeneration &&
      oldActiveGeneration !==
        importState.generation
        ? oldActiveGeneration
        : oldPreviousGeneration,
    count: exactCount,
    revision: state.revision + 1,
    importedAt:
      new Date().toISOString()
  };

  await writeMetadata(
    STATE_KEY,
    nextState
  );

  state = nextState;
  stateLoaded = true;

  lookupCache.clear();

  await deleteMetadata(IMPORT_KEY);

  notifyFilteringChanged();

  return {
    ...publicStatus(null),
    exactCount,
    retainedPreviousGeneration:
      state.previousGeneration
  };
}

async function abandonImport(
  message
) {
  await ensureInitialized();

  const importState =
    await readMetadata(IMPORT_KEY);

  if (!importState) {
    return {
      abandoned: false,
      message:
        "No unfinished build exists."
    };
  }

  if (
    message.importId &&
    importState.importId !==
      message.importId
  ) {
    throw new Error(
      "The import ID does not match."
    );
  }

  await deleteMetadata(IMPORT_KEY);

  return {
    abandoned: true,
    generation:
      importState.generation,
    message:
      "The unfinished build was abandoned. Use Clean unused databases to remove its database."
  };
}

async function cleanUnusedDatabases() {
  await ensureInitialized();

  const importState =
    await readMetadata(IMPORT_KEY);

  const protectedGenerations =
    new Set();

  if (state.activeGeneration) {
    protectedGenerations.add(
      state.activeGeneration
    );
  }

  if (state.previousGeneration) {
    protectedGenerations.add(
      state.previousGeneration
    );
  }

  if (
    importState?.status ===
      "building" &&
    importState.generation
  ) {
    protectedGenerations.add(
      importState.generation
    );
  }

  const known =
    await readKnownGenerations();

  const candidates = known.filter(
    (generation) =>
      !protectedGenerations.has(
        generation
      )
  );

  let deleted = 0;
  const blocked = [];
  const failed = [];

  for (
    const generation of candidates
  ) {
    try {
      const result =
        await deleteGenerationDatabase(
          generation
        );

      if (result.deleted) {
        deleted++;
      }

      if (result.blocked) {
        blocked.push(generation);
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      if (
        message
          .toLowerCase()
          .includes("blocked")
      ) {
        blocked.push(generation);
      } else {
        failed.push({
          generation,
          error: message
        });
      }
    }
  }

  return {
    deleted,
    blocked,
    failed,
    activeGeneration:
      state.activeGeneration,
    previousGeneration:
      state.previousGeneration,
    buildingGeneration:
      importState?.generation ?? null,
    remainingKnownGenerations:
      await readKnownGenerations()
  };
}

async function deletePreviousGeneration() {
  await ensureInitialized();

  const previousGeneration =
    state.previousGeneration;

  if (!previousGeneration) {
    return {
      deleted: false,
      message:
        "No retained previous generation exists."
    };
  }

  state = {
    ...state,
    previousGeneration: null,
    revision: state.revision + 1
  };

  await writeMetadata(
    STATE_KEY,
    state
  );

  try {
    const result =
      await deleteGenerationDatabase(
        previousGeneration
      );

    return {
      deleted: result.deleted,
      blocked: result.blocked,
      generation:
        previousGeneration
    };
  } catch (error) {
    return {
      deleted: false,
      blocked: true,
      generation:
        previousGeneration,
      error:
        error instanceof Error
          ? error.message
          : String(error)
    };
  }
}

async function clearAllData() {
  await ensureInitialized();

  const importState =
    await readMetadata(IMPORT_KEY);

  const generationsToDelete = [
    importState?.generation,
    state.activeGeneration,
    state.previousGeneration
  ].filter(
    (value) =>
      Number.isSafeInteger(value) &&
      value >= 1
  );

  await deleteMetadata(IMPORT_KEY);

  state = {
    ...DEFAULT_STATE,
    enabled: state.enabled,
    protectedLabels: [
      ...state.protectedLabels
    ],
    revision: state.revision + 1
  };

  await writeMetadata(
    STATE_KEY,
    state
  );

  lookupCache.clear();
  notifyFilteringChanged();

  const deletionResults = [];

  for (
    const generation of
      new Set(generationsToDelete)
  ) {
    try {
      await closeGenerationDatabase(
        generation
      );

      const result =
        await deleteDatabaseRequest(
          generationDatabaseName(
            generation
          )
        );

      if (result.deleted) {
        await unregisterGeneration(
          generation
        );
      }

      deletionResults.push({
        generation,
        ...result
      });
    } catch (error) {
      deletionResults.push({
        generation,
        deleted: false,
        blocked: false,
        error:
          error instanceof Error
            ? error.message
            : String(error)
      });
    }
  }

  return {
    ...publicStatus(null),
    deletionResults
  };
}
api.runtime.onMessage.addListener(
  (message) => {
    if (
      !message ||
      typeof message !== "object"
    ) {
      return undefined;
    }

    switch (message.type) {
      case "lookup":
        return lookupHostnames(
          message.hostnames
        ).then((blocked) => ({
          blocked,
          generation:
            state.activeGeneration,
          revision: state.revision
        }));

      case "get-status":
        return getStatus();

      case "set-settings":
        return updateSettings(message);

      case "begin-import":
        return beginImport(message);

      case "resume-import":
        return resumeImport(message);

      case "append-import-batch":
        return appendImportBatch(
          message
        );

      case "record-rejections":
        return recordRejections(
          message
        );

      case "complete-import-source":
        return completeImportSource(
          message
        );

      case "finish-import":
        return finishImport(message);

      case "abandon-import":
      case "cancel-import":
        return abandonImport(message);

      case "clean-unused-databases":
        return cleanUnusedDatabases();

      case "delete-previous-generation":
        return deletePreviousGeneration();

      case "clear-data":
        return clearAllData();

      default:
        return undefined;
    }
  }
);

ensureInitialized().catch((error) => {
  console.error(
    "Could not initialize SERP Domain Index v2:",
    error
  );
});

