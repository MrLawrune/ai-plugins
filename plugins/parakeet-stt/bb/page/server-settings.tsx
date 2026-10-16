// Settings section "Server": where the Parakeet server is, how bb signs in to it, and whether it answers.
import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { rpcContract } from "../contract.ts";
import { serverUrlSchema, type ServerResult } from "../schemas.ts";
import { refreshHealth, useHealth } from "./state.ts";
import { healthLine } from "./status.ts";
import { errorText, Row, StatusDot } from "./ui.tsx";

const RELOAD_NOTICE = "Reload the plugin to clear the setup badge";

const fieldError = (message: string | null) =>
  message ? <p role="alert" className="mt-1 text-xs text-destructive">{message}</p> : null;

export function ServerSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const health = useHealth();
  const [server, setServerInfo] = useState<ServerResult | null>(null);
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  /** The URL last sent or loaded, so Enter followed by blur saves once. */
  const sentUrl = useRef<string | null>(null);
  /** Counts edits of the URL field: a response never replaces the field after the user typed again. */
  const urlEdits = useRef(0);
  /** False until the URL field holds a loaded or typed value; an unowned (blank) field is never saved. */
  const urlOwned = useRef(false);
  /** Numbers the requests that return server info; only the newest one to have answered is shown. */
  const requestSeq = useRef(0);
  const shownSeq = useRef(0);

  /**
   * Show a response unless a newer request already answered. The URL field follows it only when
   * `urlEditsAtSend` says the user has not typed since (null: this response is not about the URL).
   */
  const adopt = useCallback((seq: number, next: ServerResult, urlEditsAtSend: number | null): boolean => {
    // Whatever answers first fills a field nobody has touched, even a response a newer one made stale.
    if (!urlOwned.current) {
      urlOwned.current = true;
      setUrl(next.serverUrl);
    }
    if (seq < shownSeq.current) return false;
    shownSeq.current = seq;
    sentUrl.current = next.serverUrl;
    setServerInfo(next);
    if (urlEditsAtSend !== null && urlEdits.current === urlEditsAtSend) setUrl(next.serverUrl);
    return true;
  }, []);

  useEffect(() => {
    let live = true;
    const seq = ++requestSeq.current;
    const edits = urlEdits.current;
    rpc.call("getServer").then(
      (s) => { if (live) adopt(seq, s, edits); },
      (cause) => { if (live) setUrlError(errorText(cause)); },
    );
    return () => { live = false; };
  }, [rpc, adopt]);

  const saveUrl = async () => {
    if (!urlOwned.current) return; // blank because nothing has loaded yet, not because the user emptied it
    const parsed = serverUrlSchema.safeParse(url);
    if (!parsed.success) {
      setUrlError(parsed.error.issues[0]!.message);
      return;
    }
    if (parsed.data === sentUrl.current) {
      setUrl(parsed.data);
      setUrlError(null);
      return;
    }
    sentUrl.current = parsed.data;
    setUrlError(null);
    const seq = ++requestSeq.current;
    const edits = urlEdits.current;
    try {
      if (adopt(seq, await rpc.call("setServer", { serverUrl: parsed.data }), edits)) void refreshHealth();
    } catch (cause) {
      if (sentUrl.current === parsed.data) sentUrl.current = server?.serverUrl ?? null;
      setUrlError(errorText(cause));
    }
  };

  const saveKey = async (apiKey: string | null) => {
    setKeyError(null);
    const seq = ++requestSeq.current;
    const issuedFor = typedKey; // a Clear removes the stored key and only the text that was showing when it went out
    try {
      adopt(seq, await rpc.call("setServer", { apiKey }), null);
      setKey((now) => (now.trim() === (apiKey ?? issuedFor) ? "" : now)); // keep text typed since this went out
      void refreshHealth();
    } catch (cause) {
      setKeyError(errorText(cause));
    }
  };

  const typedKey = key.trim();
  const check = async () => {
    setChecking(true);
    try {
      await refreshHealth();
    } finally {
      setChecking(false);
    }
  };

  const line = healthLine(health);
  const keySet = server?.apiKeySet === true;
  return (
    <div className="space-y-5">
      <p className="flex items-center gap-2 text-sm font-medium" role="status">
        <StatusDot tone={line.tone} />
        {line.text}
      </p>

      <Row label="Server URL" hint="The address of your Parakeet server." htmlFor="parakeet-server-url">
        <Input
          id="parakeet-server-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://"
          value={url}
          aria-invalid={urlError !== null}
          onChange={(e) => { urlEdits.current++; urlOwned.current = true; setUrl(e.target.value); setUrlError(null); }}
          onBlur={() => void saveUrl()}
          onKeyDown={(e) => { if (e.key === "Enter") void saveUrl(); }}
        />
        {fieldError(urlError)}
      </Row>

      <Row label="API key" hint="Leave empty if the server needs none. The saved key is never shown." htmlFor="parakeet-server-key">
        <div className="flex items-center gap-2">
          <Input
            id="parakeet-server-key"
            type="password"
            autoComplete="off"
            placeholder={keySet ? "Set" : "Not set"}
            value={key}
            onChange={(e) => { setKey(e.target.value); setKeyError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && typedKey !== "") void saveKey(typedKey); }}
          />
          <Button size="sm" disabled={typedKey === ""} onClick={() => void saveKey(typedKey)}>Save</Button>
          <Button size="sm" variant="outline" disabled={!keySet} onClick={() => void saveKey(null)}>Clear</Button>
        </div>
        {fieldError(keyError)}
      </Row>

      {server?.needsReload ? <p className="text-xs text-muted-foreground">{RELOAD_NOTICE}</p> : null}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={checking} onClick={() => void check()}>Check</Button>
        <Button size="sm" variant="outline" onClick={() => navigate.toPluginPanel("parakeet")}>Open dictation settings</Button>
      </div>
    </div>
  );
}
