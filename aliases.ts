// ---------------------------------------------------------------------------
// alias maps & normalizers for edit / write / read
// ---------------------------------------------------------------------------

export const PATH_FIELD_ALIASES = {
  path: ["file", "filePath", "file_path", "target", "filename", "file_name"],
} as const;

export const EDIT_FIELD_ALIASES: Record<string, readonly string[]> = {
  ...PATH_FIELD_ALIASES,
  oldText: [
    "old_str",
    "old_string",
    "old_text",
    "oldStr",
    "oldString",
    "oldContent",
    "old_content",
    "old",
    "original",
    "search",
  ],
  newText: [
    "new_str",
    "new_string",
    "new_text",
    "newStr",
    "newString",
    "newContent",
    "new_content",
    "new",
    "replacement",
    "replace",
  ],
};

export const WRITE_FIELD_ALIASES: Record<string, readonly string[]> = {
  ...PATH_FIELD_ALIASES,
  content: [
    "text",
    "body",
    "code",
    "data",
    "fileContent",
    "file_content",
    "contents",
  ],
};

export const READ_FIELD_ALIASES: Record<string, readonly string[]> = {
  ...PATH_FIELD_ALIASES,
  offset: ["start", "startLine", "start_line", "from", "line"],
  limit: ["lines", "maxLines", "max_lines", "count", "numLines", "num_lines"],
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export const buildAliasMap = (aliases: Record<string, readonly string[]>) => {
  const map = new Map<string, string>();
  for (const [canonical, alts] of Object.entries(aliases)) {
    for (const alt of alts) {
      if (!map.has(alt)) map.set(alt, canonical);
    }
  }
  return map;
};

export const editAliasMap = buildAliasMap(EDIT_FIELD_ALIASES);
export const writeAliasMap = buildAliasMap(WRITE_FIELD_ALIASES);
export const readAliasMap = buildAliasMap(READ_FIELD_ALIASES);

export const renameAliasKeys = (
  obj: Record<string, unknown>,
  canonicalKeys: Record<string, readonly string[]>,
  aliasMap: Map<string, string>,
) => {
  for (const [key, value] of Object.entries(obj)) {
    const canonical = key in canonicalKeys ? key : aliasMap.get(key);
    if (canonical && canonical !== key) {
      obj[canonical] = value;
      delete obj[key];
    }
  }
};

// ---------------------------------------------------------------------------
// normalizers — mutate in place
// ---------------------------------------------------------------------------

export const normalizeEditArgs = (args: Record<string, unknown>): Record<string, unknown> => {
  renameAliasKeys(args, EDIT_FIELD_ALIASES, editAliasMap);

  // Pattern A: oldText/newText at top level (no edits array) → wrap
  if (
    !Array.isArray(args.edits) &&
    typeof args.oldText === "string" &&
    typeof args.newText === "string"
  ) {
    args.edits = [{ oldText: args.oldText, newText: args.newText }];
    delete args.oldText;
    delete args.newText;
  }

  // Pattern B: alias keys at top level → wrap into edits
  if (!Array.isArray(args.edits)) {
    const topOld = Object.keys(args).find((k) => editAliasMap.get(k) === "oldText");
    const topNew = Object.keys(args).find((k) => editAliasMap.get(k) === "newText");
    if (
      topOld &&
      topNew &&
      typeof args[topOld] === "string" &&
      typeof args[topNew] === "string"
    ) {
      args.edits = [{ oldText: args[topOld], newText: args[topNew] }];
      delete args[topOld];
      delete args[topNew];
    }
  }

  // Pattern C: edits is a JSON string → parse it
  if (!Array.isArray(args.edits) && typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) {
        args.edits = parsed;
      }
    } catch {
      // Ignore
    }
  }

  // Normalize keys inside each edit object
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit === "object") {
        renameAliasKeys(edit as Record<string, unknown>, EDIT_FIELD_ALIASES, editAliasMap);
      }
    }
  }

  return args;
};

export const normalizeWriteArgs = (args: Record<string, unknown>): Record<string, unknown> => {
  renameAliasKeys(args, WRITE_FIELD_ALIASES, writeAliasMap);
  return args;
};

export const normalizeReadArgs = (args: Record<string, unknown>): Record<string, unknown> => {
  renameAliasKeys(args, READ_FIELD_ALIASES, readAliasMap);

  if (typeof args.offset === "string") {
    const n = parseFloat(args.offset);
    if (!isNaN(n)) args.offset = n;
  }
  if (typeof args.limit === "string") {
    const n = parseFloat(args.limit);
    if (!isNaN(n)) args.limit = n;
  }

  return args;
};
