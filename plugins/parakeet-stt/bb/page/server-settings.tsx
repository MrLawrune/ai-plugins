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
  const [server, setServer] = useState<ServerResult | null>(null);
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  /** The URL last sent or loaded, so Enter followed by blur saves once. */
  const sentUrl = useRef<string | null>(null);

  const adopt = useCallback((next: ServerResult) => {
    sentUrl.current = next.serverUrl;
    setServer(next);
    setUrl(next.serverUrl);
  }, []);

  useEffect(() => {
    let live = true;
    rpc.call("getServer").then(
      (s) => { if (live) adopt(s); },
      (cause) => { if (live) setUrlError(errorText(cause)); },
    );
    return () => { live = false; };
  }, [rpc, adopt]);

  const saveUrl = async () => {
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
    try {
      adopt(await rpc.call("setServer", { serverUrl: parsed.data }));
      void refreshHealth();
    } catch (cause) {
      sentUrl.current = server?.serverUrl ?? null;
      setUrlError(errorText(cause));
    }
  };

  const saveKey = async (apiKey: string | null) => {
    setKeyError(null);
    try {
      setServer(await rpc.call("setServer", { apiKey }));
      setKey("");
      void refreshHealth();
    } catch (cause) {
      setKeyError(errorText(cause));
    }
  };

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
          onChange={(e) => { setUrl(e.target.value); setUrlError(null); }}
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
          />
          <Button size="sm" disabled={key === ""} onClick={() => void saveKey(key)}>Save</Button>
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
