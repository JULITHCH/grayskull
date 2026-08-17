import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Settings } from "../config/settings";
import type { McpManager } from "../mcp/manager";
import type { LlmClient } from "../llm/client";
import {
  listGroups,
  applyField,
  saveGlobal,
  recheckServices,
  addPreset,
  removePreset,
  type SetupField,
  type ServiceRow,
  type ServiceState,
} from "../setup/core";

/** /setup dialog (terminal): renders the shared schema-driven setup core —
 *  grouped LLM configs (active + presets) edited in place, service health
 *  with fix instructions. Field kinds: text/number edit inline, enum cycles
 *  its options, toggle flips. */

const STATE_ICON: Record<ServiceState, { icon: string; color: string }> = {
  connected: { icon: "●", color: "green" },
  connecting: { icon: "◐", color: "yellow" },
  failed: { icon: "✗", color: "red" },
  inactive: { icon: "○", color: "gray" },
  unconfigured: { icon: "○", color: "gray" },
};

type Row =
  | { type: "header"; title: string; removable?: string }
  | { type: "field"; field: SetupField; removable?: string };

export interface SetupDialogProps {
  cwd: string;
  settings: Settings;
  mcp: McpManager;
  client: LlmClient;
  onNote: (text: string) => void;
  onClose: () => void;
}

export function SetupDialog(props: SetupDialogProps): React.ReactElement {
  const { cwd, settings, mcp, client, onNote, onClose } = props;
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [checking, setChecking] = useState(true);
  const [sel, setSel] = useState(1); // 0 is the first header
  const [editing, setEditing] = useState(false);
  /** editing a new preset's name instead of the selected field's value */
  const [adding, setAdding] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [editCur, setEditCur] = useState(0);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const aliveRef = useRef(true);

  const recheck = async (reconnectFailed: boolean): Promise<void> => {
    setChecking(true);
    const rows = await recheckServices(settings, mcp, cwd, reconnectFailed);
    if (!aliveRef.current) return;
    setServices(rows);
    setChecking(false);
  };

  useEffect(() => {
    void recheck(false);
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const rows: Row[] = [];
  for (const g of listGroups(settings)) {
    rows.push({ type: "header", title: g.title, ...(g.removable ? { removable: g.removable } : {}) });
    for (const f of g.fields) {
      rows.push({ type: "field", field: f, ...(g.removable ? { removable: g.removable } : {}) });
    }
  }

  const move = (dir: 1 | -1) => {
    let i = sel;
    do {
      i += dir;
    } while (i >= 0 && i < rows.length && rows[i]!.type !== "field");
    if (i >= 0 && i < rows.length) setSel(i);
  };

  const markDirty = (id: string) =>
    setDirty((prev) =>
      new Set(prev).add(id.startsWith("preset.") ? "models" : id.startsWith("family.") ? "families" : id),
    );

  const apply = (field: SetupField, value: string) => {
    const ok = applyField(field.id, value, {
      settings,
      client,
      mcp,
      onAsyncChange: () => {
        if (aliveRef.current) void recheck(false);
      },
    });
    if (ok) markDirty(field.id);
    else onNote(`setup: invalid value for ${field.label}`);
  };

  const activate = () => {
    const row = rows[sel];
    if (row?.type !== "field") return;
    const f = row.field;
    if (f.kind === "multiline") {
      return onNote(`setup: "${f.label}" is multi-line — edit it in the web UI (⚙ → DISCORD) or edit the file directly`);
    }
    if (f.kind === "toggle") return apply(f, f.value === "on" ? "off" : "on");
    if (f.kind === "enum" && f.options?.length) {
      const next = f.options[(f.options.indexOf(f.value) + 1) % f.options.length]!;
      return apply(f, next);
    }
    setEditValue(f.value);
    setEditCur(f.value.length);
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    if (adding) {
      setAdding(false);
      const name = addPreset(settings, editValue);
      if (name === null) return onNote("setup: preset name empty or already taken");
      setDirty((prev) => new Set(prev).add("models"));
      onNote(`setup: LLM "${name}" added (cloned from the active stack) — adjust its fields, then s to save`);
      return;
    }
    const row = rows[sel];
    if (row?.type !== "field") return;
    const v = editValue.trim();
    if (v === row.field.value) return;
    apply(row.field, v);
  };

  useInput((char, key) => {
    if (editing) {
      if (key.return) return commitEdit();
      if (key.escape) {
        setAdding(false);
        return setEditing(false);
      }
      if (key.leftArrow) return setEditCur((c) => Math.max(0, c - 1));
      if (key.rightArrow) return setEditCur((c) => Math.min(editValue.length, c + 1));
      if (key.ctrl && char === "a") return setEditCur(0);
      if (key.ctrl && char === "e") return setEditCur(editValue.length);
      if (key.backspace || key.delete) {
        if (editCur > 0) {
          setEditValue(editValue.slice(0, editCur - 1) + editValue.slice(editCur));
          setEditCur(editCur - 1);
        }
        return;
      }
      if (char && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
        const chunk = char.replace(/\[20[01]~/g, "");
        if (!chunk) return;
        setEditValue(editValue.slice(0, editCur) + chunk + editValue.slice(editCur));
        setEditCur(editCur + chunk.length);
      }
      return;
    }
    if (key.escape || char === "q") return onClose();
    if (key.upArrow) return move(-1);
    if (key.downArrow) return move(1);
    if (key.return || char === "e") return activate();
    if (char === "a") {
      setAdding(true);
      setEditValue("");
      setEditCur(0);
      setEditing(true);
      return;
    }
    if (char === "x") {
      const row = rows[sel];
      if (row?.type !== "field" || !row.removable) return;
      if (removePreset(settings, row.removable)) {
        setDirty((prev) => new Set(prev).add(row.removable!.startsWith("family:") ? "families" : "models"));
        let newLen = 0;
        for (const g of listGroups(settings)) newLen += 1 + g.fields.length;
        setSel((s) => Math.max(1, Math.min(s, newLen - 1)));
        onNote(`setup: LLM "${row.removable}" removed — s to save (defaults stay gone once saved)`);
      }
      return;
    }
    if (char === "r") return void recheck(true);
    if (char === "s") {
      if (dirty.size === 0) return onNote("setup: nothing changed — nothing to save");
      try {
        const path = saveGlobal(settings, dirty);
        setDirty(new Set());
        onNote(`setup: saved ${dirty.size} change${dirty.size > 1 ? "s" : ""} → ${path}`);
      } catch (err) {
        onNote(`setup: save failed: ${(err as Error).message}`);
      }
    }
  });

  const isDirty = (f: SetupField) =>
    dirty.has(f.id) ||
    (f.id.startsWith("preset.") && dirty.has("models")) ||
    (f.id.startsWith("family.") && dirty.has("families"));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>
        ⚙ GRAYSKULL setup
        {dirty.size > 0 && <Text color="yellow"> · {dirty.size} unsaved (press s)</Text>}
      </Text>

      {rows.map((row, i) => {
        if (row.type === "header") {
          return (
            <Box key={`h${i}`} marginTop={1}>
              <Text bold>{row.title}</Text>
              {row.removable && <Text dimColor> (x removes)</Text>}
            </Box>
          );
        }
        const f = row.field;
        const isSel = i === sel;
        const isEdit = isSel && editing && !adding;
        return (
          <Box key={f.id}>
            <Text color={isSel ? "cyan" : undefined}>
              {isSel ? "▸ " : "  "}
              {f.label.padEnd(19)}
            </Text>
            {isEdit ? (
              <Text>
                {editValue.slice(0, editCur)}
                <Text inverse>{editValue[editCur] ?? " "}</Text>
                {editValue.slice(editCur + 1)}
              </Text>
            ) : (
              <Text color={isDirty(f) ? "yellow" : undefined}>
                {f.kind === "enum" ? `‹ ${f.value} ›` : f.kind === "toggle" ? (f.value === "on" ? "[on]" : "[off]") : f.kind === "multiline" ? `(${f.value.split("\n").length} lines — web UI)` : f.value || "—"}
              </Text>
            )}
            {!isEdit && f.hint && <Text dimColor>{"  "}{f.hint}</Text>}
          </Box>
        );
      })}

      {adding && editing && (
        <Box marginTop={1}>
          <Text color="cyan">{"▸ new LLM name       "}</Text>
          <Text>
            {editValue.slice(0, editCur)}
            <Text inverse>{editValue[editCur] ?? " "}</Text>
            {editValue.slice(editCur + 1)}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text bold>SERVICES</Text>
        {checking && <Text dimColor> checking…</Text>}
      </Box>
      {services.map((s) => (
        <Box key={s.name} flexDirection="column">
          <Text>
            <Text color={STATE_ICON[s.state].color}>{STATE_ICON[s.state].icon}</Text>
            {" "}
            {s.name.padEnd(12)}
            <Text dimColor>{s.detail}</Text>
          </Text>
          {s.instructions.map((line, i) => (
            <Text key={i} color="yellow" dimColor>
              {"      ↳ "}
              {line}
            </Text>
          ))}
        </Box>
      ))}

      <Box marginTop={1}>
        <Text dimColor>
          {editing
            ? adding
              ? "enter create LLM · esc cancel"
              : "enter apply · esc cancel edit"
            : "↑↓ select · enter edit/cycle/flip · a add LLM · x remove LLM · s save · r recheck · esc close"}
        </Text>
      </Box>
    </Box>
  );
}
