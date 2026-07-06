import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Settings } from "../config/settings";
import {
  loadHub,
  rankSkills,
  fetchSkillDetail,
  installSkill,
  type RemoteSkill,
  type RemoteSkillDetail,
} from "../skills/hub";

/** /skills browse dialog (terminal): one search box over every configured
 *  skill database (settings.skillRepos). Type to filter, ↑↓ select, enter
 *  opens the SKILL.md preview, l/g installs (project/global). */

const LIST_ROWS = 12;
const skillKey = (s: RemoteSkill) => `${s.repo}/${s.path}`;

export interface SkillHubDialogProps {
  cwd: string;
  settings: Settings;
  initialQuery?: string;
  onNote: (text: string) => void;
  onClose: () => void;
}

export function SkillHubDialog(props: SkillHubDialogProps): React.ReactElement {
  const { cwd, settings, initialQuery, onNote, onClose } = props;
  const [catalog, setCatalog] = useState<RemoteSkill[] | null>(null);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [cur, setCur] = useState((initialQuery ?? "").length);
  const [sel, setSel] = useState(0);
  const [detail, setDetail] = useState<RemoteSkillDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [status, setStatus] = useState("");
  const detailCache = useRef(new Map<string, RemoteSkillDetail>());
  const aliveRef = useRef(true);

  useEffect(() => {
    void (async () => {
      const errors: string[] = [];
      const all = await loadHub(settings.skillRepos, (repo, msg) => errors.push(`${repo}: ${msg}`));
      if (!aliveRef.current) return;
      setCatalog(all);
      setLoadErrors(errors);
    })();
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const hits = catalog ? rankSkills(catalog, query, 200) : [];
  const selSkill = hits[Math.min(sel, Math.max(0, hits.length - 1))];

  const openDetail = async (skill: RemoteSkill) => {
    const key = skillKey(skill);
    const cached = detailCache.current.get(key);
    if (cached) {
      setDetail(cached);
      setDetailOpen(true);
      return;
    }
    setStatus(`fetching ${skill.name}…`);
    setDetail(null);
    setDetailOpen(true);
    try {
      const d = await fetchSkillDetail(skill, settings.skillRepos);
      if (!aliveRef.current) return;
      detailCache.current.set(key, d);
      setDetail(d);
      setStatus("");
    } catch (err) {
      if (!aliveRef.current) return;
      setDetailOpen(false);
      setStatus(`fetch failed: ${(err as Error).message}`);
    }
  };

  const install = async (scope: "local" | "global") => {
    if (!detail) return;
    setStatus(`installing ${detail.name} (${scope})…`);
    try {
      const { dir, fileCount } = await installSkill(detail, scope, cwd);
      if (!aliveRef.current) return;
      setStatus(`⚡ installed → ${dir} (${fileCount} files)`);
      onNote(`⚡ skill "${detail.name}" installed (${scope}) → ${dir} — invoke with /${detail.name}`);
    } catch (err) {
      if (!aliveRef.current) return;
      setStatus(`install failed: ${(err as Error).message}`);
    }
  };

  useInput((char, key) => {
    if (detailOpen) {
      if (key.escape || char === "q") {
        setDetailOpen(false);
        setStatus("");
        return;
      }
      if (char === "l") return void install("local");
      if (char === "g") return void install("global");
      return;
    }
    if (key.escape) return onClose();
    if (key.upArrow) return setSel((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSel((s) => Math.min(hits.length - 1, s + 1));
    if (key.return) {
      if (selSkill) void openDetail(selSkill);
      return;
    }
    if (key.leftArrow) return setCur((c) => Math.max(0, c - 1));
    if (key.rightArrow) return setCur((c) => Math.min(query.length, c + 1));
    if (key.ctrl && char === "a") return setCur(0);
    if (key.ctrl && char === "e") return setCur(query.length);
    if (key.ctrl && char === "u") {
      setQuery("");
      setCur(0);
      setSel(0);
      return;
    }
    if (key.backspace || key.delete) {
      if (cur > 0) {
        setQuery(query.slice(0, cur - 1) + query.slice(cur));
        setCur(cur - 1);
        setSel(0);
      }
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      const chunk = char.replace(/\[20[01]~/g, "");
      if (!chunk) return;
      setQuery(query.slice(0, cur) + chunk + query.slice(cur));
      setCur(cur + chunk.length);
      setSel(0);
    }
  });

  // windowed list around the selection
  const start = Math.max(0, Math.min(sel - Math.floor(LIST_ROWS / 2), hits.length - LIST_ROWS));
  const visible = hits.slice(start, start + LIST_ROWS);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
      <Text color="magenta" bold>
        ⚡ SKILL HUB
        <Text dimColor>
          {" "}
          {catalog
            ? `${catalog.length} skills · ${settings.skillRepos.filter((r) => !r.disabled).length} databases`
            : "loading databases…"}
        </Text>
      </Text>

      {detailOpen ? (
        detail ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="cyan">
              {detail.name} <Text dimColor>[{detail.source}] {detail.repo}/{detail.path}</Text>
            </Text>
            <Text wrap="wrap">{detail.description || "(no description)"}</Text>
            <Box marginTop={1} flexDirection="column">
              {detail.body.split("\n").slice(0, 14).map((line, i) => (
                <Text key={i} dimColor wrap="truncate-end">
                  {line || " "}
                </Text>
              ))}
              {detail.body.split("\n").length > 14 && <Text dimColor>…</Text>}
            </Box>
            <Text dimColor>{detail.files.length} file{detail.files.length === 1 ? "" : "s"}</Text>
          </Box>
        ) : (
          <Text dimColor>{status || "fetching…"}</Text>
        )
      ) : (
        <>
          <Box marginTop={1}>
            <Text color="magenta">{"search ▸ "}</Text>
            <Text>
              {query.slice(0, cur)}
              <Text inverse>{query[cur] ?? " "}</Text>
              {query.slice(cur + 1)}
            </Text>
            {hits.length > 0 && <Text dimColor>{"  "}{hits.length >= 200 ? "200+" : hits.length} hits</Text>}
          </Box>

          {visible.map((h, i) => {
            const isSel = start + i === sel;
            return (
              <Text key={skillKey(h)} color={isSel ? "cyan" : undefined}>
                {isSel ? "▸ " : "  "}
                {h.name.slice(0, 40).padEnd(42)}
                <Text dimColor>[{h.source}]</Text>
              </Text>
            );
          })}
          {catalog && hits.length === 0 && <Text dimColor>  no skill matches "{query}"</Text>}
        </>
      )}

      {loadErrors.map((e, i) => (
        <Text key={i} color="yellow" dimColor>
          ⚠ {e}
        </Text>
      ))}
      {!detailOpen && status !== "" && <Text color="yellow">{status}</Text>}

      <Box marginTop={1}>
        <Text dimColor>
          {detailOpen
            ? detail
              ? "l install to project · g install global · esc back"
              : "esc back"
            : "type to search · ↑↓ select · enter preview · esc close"}
        </Text>
      </Box>
    </Box>
  );
}
