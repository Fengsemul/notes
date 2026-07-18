"use strict";

const api = globalThis.browser ?? globalThis.chrome;

const LOOKUP_BATCH_SIZE = 256;
const HOSTNAME_CACHE_LIMIT = 2000;

const ENGINE_CONFIGS = Object.freeze([
  {
    matches(hostname) {
      return hostname.includes("google.");
    },
    resultSelectors: [
      "#search .MjjYud",
      "#search .g",
      "#rso > div[data-hveid]",
      "#botstuff .MjjYud"
    ],
    preferredLinkSelectors: [
      "a[href] h3"
    ],
    unwrapUrl(url) {
      if (
        url.pathname === "/url" &&
        url.hostname.includes("google.")
      ) {
        const target =
          url.searchParams.get("q") ??
          url.searchParams.get("url");

        if (target) {
          try {
            return new URL(target);
          } catch {
            return null;
          }
        }
      }

      return url;
    }
  },
  {
    matches(hostname) {
      return hostname.endsWith("bing.com");
    },
    resultSelectors: [
      "#b_results > li.b_algo"
    ],
    preferredLinkSelectors: [
      "h2 > a[href]"
    ]
  },
  {
    matches(hostname) {
      return hostname.endsWith("duckduckgo.com");
    },
    resultSelectors: [
      "article[data-testid='result']",
      ".react-results--main article",
      ".results_links",
      ".result"
    ],
    preferredLinkSelectors: [
      "a[data-testid='result-title-a']",
      "a.result__a"
    ],
    unwrapUrl(url) {
      if (
        url.hostname.endsWith("duckduckgo.com") &&
        url.pathname === "/l/"
      ) {
        const target = url.searchParams.get("uddg");

        if (target) {
          try {
            return new URL(target);
          } catch {
            return null;
          }
        }
      }

      return url;
    }
  },
  {
    matches(hostname) {
      return hostname === "search.yahoo.com";
    },
    resultSelectors: [
      "#web > ol > li",
      "#web .dd.algo"
    ],
    preferredLinkSelectors: [
      "h3 a[href]"
    ]
  },
  {
    matches(hostname) {
      return hostname.endsWith("startpage.com");
    },
    resultSelectors: [
      ".w-gl__result",
      ".result"
    ],
    preferredLinkSelectors: [
      "a.result-title[href]",
      "h3 a[href]"
    ]
  },
  {
    matches(hostname) {
      return hostname.endsWith("ecosia.org");
    },
    resultSelectors: [
      "article.result",
      ".result"
    ],
    preferredLinkSelectors: [
      "a.result-title[href]",
      "h2 a[href]"
    ]
  },
  {
    matches(hostname) {
      return hostname === "search.brave.com";
    },
    resultSelectors: [
      ".snippet[data-type='web']",
      "[data-type='web']"
    ],
    preferredLinkSelectors: [
      "a[href] h2",
      "a[href] .title"
    ]
  },
  {
    matches(hostname) {
      return (
        hostname.endsWith("yandex.com") ||
        hostname.endsWith("yandex.ru")
      );
    },
    resultSelectors: [
      "li.serp-item",
      ".serp-item"
    ],
    preferredLinkSelectors: [
      "a.Link[href]",
      "h2 a[href]"
    ]
  }
]);

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
      const oldestKey = this.values.keys().next().value;
      this.values.delete(oldestKey);
    }
  }

  has(key) {
    return this.values.has(key);
  }

  clear() {
    this.values.clear();
  }
}

const pageHostname = location.hostname
  .toLowerCase()
  .replace(/\.$/, "");

const engine = ENGINE_CONFIGS.find((candidate) =>
  candidate.matches(pageHostname)
);

if (engine) {
  initialize().catch((error) => {
    console.error(
      "SERP Domain Index failed to initialize:",
      error
    );
  });
}

function anchorFromPreferredMatch(result, selector) {
  const match = result.querySelector(selector);

  if (!match) {
    return null;
  }

  if (match instanceof HTMLAnchorElement) {
    return match;
  }

  return match.closest("a[href]");
}

function destinationFromAnchor(anchor) {
  if (!(anchor instanceof HTMLAnchorElement)) {
    return null;
  }

  const rawHref = anchor.getAttribute("href");

  if (
    !rawHref ||
    rawHref.startsWith("#") ||
    rawHref.toLowerCase().startsWith("javascript:")
  ) {
    return null;
  }

  let url;

  try {
    url = new URL(rawHref, location.href);
  } catch {
    return null;
  }

  if (typeof engine.unwrapUrl === "function") {
    url = engine.unwrapUrl(url);
  }

  if (
    !url ||
    (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    )
  ) {
    return null;
  }

  const destinationHostname = url.hostname
    .toLowerCase()
    .replace(/\.$/, "");

  if (
    !destinationHostname ||
    destinationHostname === pageHostname
  ) {
    return null;
  }

  return url;
}

function primaryDestination(result) {
  for (
    const selector of
      engine.preferredLinkSelectors ?? []
  ) {
    const anchor = anchorFromPreferredMatch(
      result,
      selector
    );

    const destination =
      destinationFromAnchor(anchor);

    if (destination) {
      return destination;
    }
  }

  for (
    const anchor of
      result.querySelectorAll("a[href]")
  ) {
    const destination =
      destinationFromAnchor(anchor);

    if (destination) {
      return destination;
    }
  }

  return null;
}

function setResultHidden(result, hidden) {
  if (!(result instanceof HTMLElement)) {
    return;
  }

  if (hidden) {
    if (
      result.dataset.serpDomainIndexHidden !== "1"
    ) {
      result.dataset.serpDomainIndexPreviousDisplay =
        result.style.getPropertyValue("display");

      result.dataset.serpDomainIndexPreviousPriority =
        result.style.getPropertyPriority("display");
    }

    result.style.setProperty(
      "display",
      "none",
      "important"
    );

    result.dataset.serpDomainIndexHidden = "1";
    return;
  }

  if (
    result.dataset.serpDomainIndexHidden !== "1"
  ) {
    return;
  }

  const previousDisplay =
    result.dataset.serpDomainIndexPreviousDisplay ??
    "";

  const previousPriority =
    result.dataset.serpDomainIndexPreviousPriority ??
    "";

  if (previousDisplay) {
    result.style.setProperty(
      "display",
      previousDisplay,
      previousPriority
    );
  } else {
    result.style.removeProperty("display");
  }

  delete result.dataset.serpDomainIndexHidden;
  delete result.dataset.serpDomainIndexPreviousDisplay;
  delete result.dataset.serpDomainIndexPreviousPriority;
}

function collectResults(root, selector, output) {
  if (
    root instanceof Element &&
    root.matches(selector)
  ) {
    output.add(root);
  }

  if (
    root instanceof Document ||
    root instanceof Element
  ) {
    for (
      const result of
        root.querySelectorAll(selector)
    ) {
      output.add(result);
    }
  }
}

function normalizeDestinationHostname(value) {
  const hostname = String(value)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");

  if (
    !hostname ||
    hostname.length > 253 ||
    hostname.includes(":") ||
    !hostname.includes(".")
  ) {
    return "";
  }

  return hostname;
}

async function initialize() {
  const resultSelector =
    engine.resultSelectors.join(",");

  const pendingResults = new Set();
  const hostnameCache = new LruCache(
    HOSTNAME_CACHE_LIMIT
  );

  let animationFramePending = false;
  let processing = false;
  let processAgain = false;
  let lookupRevision = 0;
  let observer = null;

  function queueResult(result) {
    if (
      result instanceof Element &&
      result.isConnected
    ) {
      pendingResults.add(result);
    }
  }

  function queueResultsFromRoot(root) {
    collectResults(
      root,
      resultSelector,
      pendingResults
    );

    requestProcessing();
  }

  function requestProcessing() {
    if (pendingResults.size === 0) {
      return;
    }

    if (processing) {
      processAgain = true;
      return;
    }

    if (animationFramePending) {
      return;
    }

    animationFramePending = true;

    requestAnimationFrame(() => {
      animationFramePending = false;

      processPendingResults().catch((error) => {
        console.error(
          "SERP Domain Index processing failed:",
          error
        );
      });
    });
  }

  async function processPendingResults() {
    if (processing) {
      processAgain = true;
      return;
    }

    processing = true;
    const localRevision = lookupRevision;

    try {
      do {
        processAgain = false;

        const results =
          Array.from(pendingResults);

        pendingResults.clear();

        if (results.length === 0) {
          continue;
        }

        const resultToHostname = new Map();
        const unresolvedHostnames = new Set();

        for (const result of results) {
          if (
            !(result instanceof HTMLElement) ||
            !result.isConnected
          ) {
            continue;
          }

          const destination =
            primaryDestination(result);

          const hostname =
            normalizeDestinationHostname(
              destination?.hostname ?? ""
            );

          resultToHostname.set(
            result,
            hostname
          );

          if (!hostname) {
            setResultHidden(result, false);
            continue;
          }

          const cached =
            hostnameCache.get(hostname);

          if (cached !== undefined) {
            setResultHidden(result, cached);
          } else {
            unresolvedHostnames.add(hostname);
          }
        }

        const hostnames =
          Array.from(unresolvedHostnames);

        for (
          let start = 0;
          start < hostnames.length;
          start += LOOKUP_BATCH_SIZE
        ) {
          if (localRevision !== lookupRevision) {
            return;
          }

          const batch = hostnames.slice(
            start,
            start + LOOKUP_BATCH_SIZE
          );

          let response;

          try {
            response =
              await api.runtime.sendMessage({
                type: "lookup",
                hostnames: batch
              });
          } catch (error) {
            console.error(
              "SERP Domain Index lookup failed:",
              error
            );

            return;
          }

          if (localRevision !== lookupRevision) {
            return;
          }

          const blocked = Array.isArray(
            response?.blocked
          )
            ? response.blocked
            : [];

          for (
            let index = 0;
            index < batch.length;
            index++
          ) {
            hostnameCache.set(
              batch[index],
              blocked[index] === true
            );
          }
        }

        if (localRevision !== lookupRevision) {
          return;
        }

        for (
          const [result, hostname] of
            resultToHostname
        ) {
          if (
            !result.isConnected ||
            !hostname
          ) {
            continue;
          }

          const hidden =
            hostnameCache.get(hostname);

          if (hidden !== undefined) {
            setResultHidden(result, hidden);
          }
        }
      } while (
        processAgain ||
        pendingResults.size > 0
      );
    } finally {
      processing = false;

      if (
        processAgain ||
        pendingResults.size > 0
      ) {
        requestProcessing();
      }
    }
  }

  function invalidateAndRescan() {
    lookupRevision++;
    hostnameCache.clear();

    collectResults(
      document,
      resultSelector,
      pendingResults
    );

    requestProcessing();
  }

  queueResultsFromRoot(document);

  observer = new MutationObserver(
    (mutationRecords) => {
      for (const record of mutationRecords) {
        for (const node of record.addedNodes) {
          if (
            node.nodeType ===
            Node.ELEMENT_NODE
          ) {
            queueResultsFromRoot(node);
          }
        }

        if (
          record.type === "attributes" &&
          record.target instanceof Element
        ) {
          const result =
            record.target.matches(
              resultSelector
            )
              ? record.target
              : record.target.closest(
                  resultSelector
                );

          if (result) {
            queueResult(result);
          }
        }
      }

      requestProcessing();
    }
  );

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "href"
    ]
  });

  api.runtime.onMessage.addListener(
    (message) => {
      if (
        message?.type !==
        "filter-state-changed"
      ) {
        return undefined;
      }

      invalidateAndRescan();
      return undefined;
    }
  );

  globalThis.addEventListener(
    "pagehide",
    () => {
      observer?.disconnect();
      pendingResults.clear();
      hostnameCache.clear();
    },
    {
      once: true
    }
  );
}
