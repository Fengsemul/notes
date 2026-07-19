"use strict";

(() => {
  const api = globalThis.browser ?? globalThis.chrome;

  const PSL_FILE = "public_suffix_list.dat";
  const MAX_PSL_BYTES = 4 * 1024 * 1024;
  const MIN_RULE_COUNT = 1000;

  let loadingPromise = null;
  let exactRules = null;
  let wildcardRules = null;
  let exceptionRules = null;
  let listVersion = "not-loaded";
  let ruleCount = 0;
  let loadedByteLength = 0;

  function normalizeRule(value) {
    return String(value)
      .trim()
      .toLowerCase()
      .replace(/^\.+/, "")
      .replace(/\.+$/, "");
  }

  function normalizeLabels(value) {
    const input = Array.isArray(value)
      ? value
      : String(value)
          .trim()
          .toLowerCase()
          .replace(/\.$/, "")
          .split(".");

    return input
      .map((label) =>
        String(label)
          .trim()
          .toLowerCase()
      )
      .filter(Boolean);
  }

  function extractVersion(text) {
    const firstLines = text
      .split(/\r?\n/, 100);

    for (const line of firstLines) {
      const match = line.match(
        /^\/\/\s*VERSION:\s*(.+?)\s*$/i
      );

      if (match) {
        return match[1]
          .trim()
          .slice(0, 200);
      }
    }

    return "bundled";
  }

  function parsePublicSuffixList(text) {
    if (
      typeof text !== "string" ||
      text.length === 0
    ) {
      throw new Error(
        "The bundled Public Suffix List is empty."
      );
    }

    if (
      !text.includes(
        "// ===BEGIN ICANN DOMAINS==="
      )
    ) {
      throw new Error(
        "The ICANN section is missing from the Public Suffix List."
      );
    }

    if (
      !text.includes(
        "// ===BEGIN PRIVATE DOMAINS==="
      )
    ) {
      throw new Error(
        "The private-domain section is missing from the Public Suffix List."
      );
    }

    const parsedExactRules = new Set();
    const parsedWildcardRules = new Set();
    const parsedExceptionRules = new Set();

    for (
      let line of text.split(/\r?\n/)
    ) {
      line = line.trim();

      if (
        !line ||
        line.startsWith("//")
      ) {
        continue;
      }

      const inlineCommentIndex =
        line.indexOf(" //");

      if (inlineCommentIndex !== -1) {
        line = line
          .slice(0, inlineCommentIndex)
          .trim();
      }

      if (!line) {
        continue;
      }

      if (line.startsWith("!")) {
        const rule = normalizeRule(
          line.slice(1)
        );

        if (rule) {
          parsedExceptionRules.add(rule);
        }

        continue;
      }

      if (line.startsWith("*.")) {
        const rule = normalizeRule(
          line.slice(2)
        );

        if (rule) {
          parsedWildcardRules.add(rule);
        }

        continue;
      }

      const rule = normalizeRule(line);

      if (rule) {
        parsedExactRules.add(rule);
      }
    }

    const totalRuleCount =
      parsedExactRules.size +
      parsedWildcardRules.size +
      parsedExceptionRules.size;

    if (
      totalRuleCount <
      MIN_RULE_COUNT
    ) {
      throw new Error(
        "The bundled Public Suffix List contains too few rules."
      );
    }

    if (
      !parsedExactRules.has("com") ||
      !parsedExactRules.has("co.uk") ||
      !parsedWildcardRules.has("ck") ||
      !parsedExceptionRules.has("www.ck")
    ) {
      throw new Error(
        "The bundled Public Suffix List failed its integrity checks."
      );
    }

    exactRules = parsedExactRules;
    wildcardRules =
      parsedWildcardRules;
    exceptionRules =
      parsedExceptionRules;
    ruleCount = totalRuleCount;
    listVersion =
      extractVersion(text);
  }

  async function load() {
    if (
      exactRules &&
      wildcardRules &&
      exceptionRules
    ) {
      return getStatus();
    }

    if (loadingPromise) {
      return loadingPromise;
    }

    loadingPromise = (async () => {
      if (
        !api?.runtime ||
        typeof api.runtime.getURL !==
          "function"
      ) {
        throw new Error(
          "The extension runtime API is unavailable."
        );
      }

      const url =
        api.runtime.getURL(PSL_FILE);

      const response = await fetch(
        url,
        {
          cache: "no-store",
          credentials: "omit"
        }
      );

      if (!response.ok) {
        throw new Error(
          "Could not load the bundled Public Suffix List: HTTP " +
            response.status +
            "."
        );
      }

      const declaredLength = Number(
        response.headers.get(
          "content-length"
        ) ?? 0
      );

      if (
        Number.isFinite(
          declaredLength
        ) &&
        declaredLength >
          MAX_PSL_BYTES
      ) {
        throw new Error(
          "The bundled Public Suffix List is unexpectedly large."
        );
      }

      const buffer =
        await response.arrayBuffer();

      loadedByteLength =
        buffer.byteLength;

      if (
        loadedByteLength === 0 ||
        loadedByteLength >
          MAX_PSL_BYTES
      ) {
        throw new Error(
          "The bundled Public Suffix List has an invalid size."
        );
      }

      const text =
        new TextDecoder(
          "utf-8",
          {
            fatal: false
          }
        ).decode(buffer);

      parsePublicSuffixList(text);

      return getStatus();
    })();

    try {
      return await loadingPromise;
    } catch (error) {
      loadingPromise = null;
      exactRules = null;
      wildcardRules = null;
      exceptionRules = null;
      listVersion = "unavailable";
      ruleCount = 0;
      loadedByteLength = 0;

      throw error;
    }
  }

  function getPublicSuffixLabelCount(
    value
  ) {
    const labels =
      normalizeLabels(value);

    if (labels.length < 2) {
      return 1;
    }

    if (
      !exactRules ||
      !wildcardRules ||
      !exceptionRules
    ) {
      return 1;
    }

    let bestRuleLength = 1;

    for (
      let start = 0;
      start < labels.length;
      start++
    ) {
      const candidate = labels
        .slice(start)
        .join(".");

      if (
        exceptionRules.has(
          candidate
        )
      ) {
        return Math.max(
          1,
          labels.length -
            start -
            1
        );
      }

      if (
        exactRules.has(candidate)
      ) {
        bestRuleLength = Math.max(
          bestRuleLength,
          labels.length - start
        );
      }

      if (
        start + 1 <
        labels.length
      ) {
        const wildcardBase =
          labels
            .slice(start + 1)
            .join(".");

        if (
          wildcardRules.has(
            wildcardBase
          )
        ) {
          bestRuleLength = Math.max(
            bestRuleLength,
            labels.length - start
          );
        }
      }
    }

    return Math.min(
      bestRuleLength,
      labels.length - 1
    );
  }

  function getStatus() {
    return Object.freeze({
      loaded: Boolean(
        exactRules &&
        wildcardRules &&
        exceptionRules
      ),
      version: listVersion,
      ruleCount,
      exactRuleCount:
        exactRules?.size ?? 0,
      wildcardRuleCount:
        wildcardRules?.size ?? 0,
      exceptionRuleCount:
        exceptionRules?.size ?? 0,
      byteLength:
        loadedByteLength
    });
  }

  globalThis.PublicSuffixData =
    Object.freeze({
      load,
      getPublicSuffixLabelCount,
      getStatus
    });
})();
