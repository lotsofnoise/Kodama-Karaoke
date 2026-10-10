// Live Karaoke Room — "Create Room" and "Join by ID" modals.
//
// Opened from anywhere (the room page, the overlay) through openKaraokeModal(); the single
// <KaraokeModalHost> mounted in App renders whichever is open. They stay mounted and are
// driven by isOpen so react-aria plays both the enter and the exit animation.

import { useEffect, useState, useSyncExternalStore } from "react";
import { cn, Button, Spinner, ModalBackdrop, ModalContainer, ModalHeader, ModalIcon, ModalHeading, ModalBody, ModalFooter, ModalCloseTrigger, TextFieldRoot, InputRoot } from "@heroui/react";
import { ModalDialog, ModalRoot } from "../ui/zoomed-heroui.jsx";
import { useLang } from "../context.jsx";
import { MicrophoneStand, Users, Globe, HardDrives, CaretDown, Headphones } from "../icons.jsx";
import { karaoke } from "./session.js";
import { isValidRoomCode, normalizeRoomCode, normalizeServer, parseInvite } from "./protocol.js";

// ── tiny store: which modal is open ───────────────────────────────────────────
let _open = null;                              // null | "create" | "join"
const _subs = new Set();
export function openKaraokeModal(kind) { _open = kind; _subs.forEach((f) => f()); }
function closeModal() { _open = null; _subs.forEach((f) => f()); }
const useOpenModal = () => useSyncExternalStore((f) => { _subs.add(f); return () => _subs.delete(f); }, () => _open);

export const ERROR_KEYS = {
  room_full: "karaokeErrRoomFull",
  room_not_found: "karaokeErrNotFound",
  unreachable: "karaokeErrUnreachable",
  forbidden: "karaokeErrForbidden",
  rate_limited: "karaokeErrRate",
  server_full: "karaokeErrServerFull",
  bad_server: "karaokeErrBadServer",
};

const fieldLabel = "text-[length:var(--t12)] font-bold uppercase tracking-[0.08em] text-muted";

function Field({ label, hint, children }) {
  return (
    <div className="flex flex-col gap-2">
      <label className={fieldLabel}>{label}</label>
      {children}
      {hint && <div className="text-[length:var(--t12)] text-muted leading-snug">{hint}</div>}
    </div>
  );
}

function ErrorLine({ code }) {
  const t = useLang();
  if (!code) return null;
  return (
    <div className="rounded-xl px-3.5 py-2.5 text-[length:var(--t13)]"
      style={{ background: "var(--status-danger-soft)", color: "var(--status-danger)", border: "1px solid var(--status-danger-line)" }}>
      {t(ERROR_KEYS[code] || "karaokeErrGeneric")}
    </div>
  );
}

function Hints() {
  const t = useLang();
  return (
    <div className="flex flex-col gap-1.5 text-[length:var(--t12)] text-muted leading-snug">
      <span className="flex items-center gap-2"><Users size={12} className="shrink-0" />{t("karaokeMax5")}</span>
      <span className="flex items-start gap-2"><Headphones size={12} className="shrink-0 mt-0.5" />{t("karaokeHeadphonesHint")}</span>
    </div>
  );
}

/** Optional TURN entry: "turn:host:3478|user|password". */
function parseTurn(raw) {
  const [urls, username, credential] = String(raw || "").split("|").map((s) => s.trim());
  if (!urls || !/^turns?:/i.test(urls)) return null;
  return { urls, username: username || undefined, credential: credential || undefined };
}

function AdvancedTurn({ value, onChange }) {
  const t = useLang();
  const [open, setOpen] = useState(!!value);
  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="self-start flex items-center gap-1.5 bg-transparent border-none text-muted text-[length:var(--t12)] cursor-pointer p-0 hover:text-secondary">
        <CaretDown size={11} style={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform .15s" }} />
        {t("karaokeAdvanced")}
      </button>
      {open && (
        <Field label={t("karaokeTurnServer")} hint={t("karaokeTurnHint")}>
          <TextFieldRoot aria-label={t("karaokeTurnServer")} value={value} onChange={onChange} className="w-full">
            <InputRoot placeholder="turn:turn.example.com:3478|user|secret" spellCheck={false} />
          </TextFieldRoot>
        </Field>
      )}
    </div>
  );
}

function currentTurn() {
  const ice = karaoke.iceServers;
  const turn = ice.find((s) => String(s.urls).startsWith("turn"));
  return turn ? [turn.urls, turn.username, turn.credential].filter(Boolean).join("|") : "";
}

function Shell({ isOpen, onClose, icon, title, children, footer }) {
  return (
    <ModalRoot isOpen={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <ModalBackdrop className="z-[300]!">
        <ModalContainer placement="center" size="lg" className="w-[560px] max-w-[92vw]">
          <ModalDialog>
            <ModalHeader>
              <ModalIcon>{icon}</ModalIcon>
              <ModalCloseTrigger />
              <ModalHeading>{title}</ModalHeading>
            </ModalHeader>
            <ModalBody>{children}</ModalBody>
            <ModalFooter>{footer}</ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </ModalRoot>
  );
}

export function CreateRoomModal({ isOpen, onClose, onDone }) {
  const t = useLang();
  const [name, setName] = useState("");
  const [mode, setMode] = useState("local");       // local | relay
  const [relay, setRelay] = useState("");
  const [turn, setTurn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    setName(karaoke.savedName);
    const savedRelay = karaoke.relayServer;
    setRelay(savedRelay);
    setMode(savedRelay ? "relay" : "local");
    setTurn(currentTurn());
    setBusy(false);
    setError(null);
  }, [isOpen]);

  const canSubmit = name.trim() && (mode === "local" || normalizeServer(relay)) && !busy;
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    karaoke.setTurnServer(parseTurn(turn));
    try {
      await karaoke.createRoom({ name: name.trim(), relay: mode === "relay" ? relay.trim() : "" });
      onDone?.("created");
      onClose();
    } catch (e) {
      setError(e.code || "error");
      setBusy(false);
    }
  };

  const opts = [
    ["local", t("karaokeHostHere"), t("karaokeHostHereDesc"), <HardDrives size={15} key="i" />],
    ["relay", t("karaokeUseRelay"), t("karaokeUseRelayDesc"), <Globe size={15} key="i" />],
  ];

  return (
    <Shell
      isOpen={isOpen}
      onClose={onClose}
      icon={<MicrophoneStand size={18} />}
      title={t("karaokeCreateRoom")}
      footer={<>
        <Button variant="ghost" onPress={onClose}>{t("cancel")}</Button>
        <Button color="accent" variant="solid" isDisabled={!canSubmit} onPress={submit}>
          {busy ? <Spinner size="sm" /> : t("karaokeCreate")}
        </Button>
      </>}
    >
      <div className="flex flex-col gap-5">
        <Field label={t("karaokeDisplayName")}>
          <TextFieldRoot aria-label={t("karaokeDisplayName")} value={name} onChange={(v) => setName(v.slice(0, 32))} className="w-full">
            <InputRoot autoFocus onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          </TextFieldRoot>
        </Field>

        <Field label={t("karaokeWhereToHost")}>
          <div className="grid grid-cols-2 gap-2">
            {opts.map(([val, label, desc, icon]) => {
              const active = mode === val;
              return (
                <button key={val} type="button" onClick={() => setMode(val)}
                  className={cn("flex flex-col items-start gap-1 px-3.5 py-3 rounded-xl text-left border-none w-full transition-colors duration-150 cursor-pointer",
                    active ? "bg-accent-dim text-accent" : "bg-transparent text-secondary hover:bg-hover")}
                  style={{ outline: active ? "none" : "1px solid var(--border)" }}>
                  <span className="flex items-center gap-2 font-semibold text-[length:var(--t13)]">{icon}{label}</span>
                  <span className="text-[length:var(--t12)] opacity-80 leading-snug">{desc}</span>
                </button>
              );
            })}
          </div>
        </Field>

        {mode === "relay" && (
          <Field label={t("karaokeRelayUrl")}>
            <TextFieldRoot aria-label={t("karaokeRelayUrl")} value={relay} onChange={setRelay} className="w-full">
              <InputRoot placeholder="https://karaoke.example.com:9847" spellCheck={false} />
            </TextFieldRoot>
          </Field>
        )}

        <Hints />

        <AdvancedTurn value={turn} onChange={setTurn} />
        <ErrorLine code={error} />
      </div>
    </Shell>
  );
}

export function JoinRoomModal({ isOpen, onClose, onDone }) {
  const t = useLang();
  const [code, setCode] = useState("");
  const [server, setServer] = useState("");
  const [name, setName] = useState("");
  const [turn, setTurn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    setCode("");
    setServer(karaoke.lastServer);
    setName(karaoke.savedName);
    setTurn(currentTurn());
    setBusy(false);
    setError(null);
  }, [isOpen]);

  // Pasting a whole invite ("ABC234@192.168.1.20") fills both fields at once.
  const onCode = (v) => {
    const inv = parseInvite(v);
    if (inv.server) setServer(inv.server.replace(/^http:\/\//, "").replace(/:9847$/, ""));
    setCode(inv.server ? inv.code : normalizeRoomCode(v));
    setError(null);
  };

  const canSubmit = isValidRoomCode(code) && normalizeServer(server) && name.trim() && !busy;
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    karaoke.setTurnServer(parseTurn(turn));
    try {
      await karaoke.joinRoom({ code, server: server.trim(), name: name.trim() });
      onDone?.("joined");
      onClose();
    } catch (e) {
      setError(e.code || "error");
      setBusy(false);
    }
  };

  return (
    <Shell
      isOpen={isOpen}
      onClose={onClose}
      icon={<Users size={18} />}
      title={t("karaokeJoinRoom")}
      footer={<>
        <Button variant="ghost" onPress={onClose}>{t("cancel")}</Button>
        <Button color="accent" variant="solid" isDisabled={!canSubmit} onPress={submit}>
          {busy ? <Spinner size="sm" /> : t("karaokeJoin")}
        </Button>
      </>}
    >
      <div className="flex flex-col gap-5">
        <Field label={t("karaokeRoomId")} hint={t("karaokeRoomIdHint")}>
          <TextFieldRoot aria-label={t("karaokeRoomId")} value={code} onChange={onCode} className="w-full">
            <InputRoot
              autoFocus
              placeholder="ABC234"
              spellCheck={false}
              autoComplete="off"
              className="kk-code text-[18px]! tracking-[0.3em]!"
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            />
          </TextFieldRoot>
        </Field>
        <Field label={t("karaokeHostAddress")} hint={t("karaokeHostAddressHint")}>
          <TextFieldRoot aria-label={t("karaokeHostAddress")} value={server} onChange={(v) => { setServer(v); setError(null); }} className="w-full">
            <InputRoot placeholder="192.168.1.20" spellCheck={false} autoComplete="off" onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          </TextFieldRoot>
        </Field>
        <Field label={t("karaokeDisplayName")}>
          <TextFieldRoot aria-label={t("karaokeDisplayName")} value={name} onChange={(v) => setName(v.slice(0, 32))} className="w-full">
            <InputRoot onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          </TextFieldRoot>
        </Field>
        <Hints />
        <AdvancedTurn value={turn} onChange={setTurn} />
        <ErrorLine code={error} />
      </div>
    </Shell>
  );
}

/** Mount once (App). Renders both modals, driven by openKaraokeModal(). */
export function KaraokeModalHost({ onDone }) {
  const open = useOpenModal();
  return (
    <>
      <CreateRoomModal isOpen={open === "create"} onClose={closeModal} onDone={onDone} />
      <JoinRoomModal isOpen={open === "join"} onClose={closeModal} onDone={onDone} />
    </>
  );
}
