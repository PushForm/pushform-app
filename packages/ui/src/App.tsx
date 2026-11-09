// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ProjectActivitySink } from '@pushform/cloud';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAppStore } from './store';
import { ExtensionInspectorContext } from './extensions/ExtensionInspectors';

import type { JSX } from 'react';
import { createPortal } from 'react-dom';
import { CommonsBrowser } from './components/CommonsBrowser';
import { CommonsOpening, type CommonsOpeningConfig } from './components/CommonsOpening';
import { AppContext } from './AppContext';
import { createApp } from './bootstrap';
import type { AppInstance } from './bootstrap';
import { MainToolbar } from './components/MainToolbar';
import { documentToolsFor } from './documentTools';
import { chatPublishing, type PublicationPreset } from './chatPublishing';
import { PublishSnapshot } from './components/PublishSnapshot';
import type { PublishingSnapshot } from './components/SaveVersionDialog';
import { captureRequestScreenshot } from './requestScreenshot';
import { PanelHost } from './components/PanelHost';
import { RightStrip } from './components/RightStrip';
import { StatusBar } from './components/StatusBar';
import { AutosaveIndicator } from './components/AutosaveIndicator';
import { TopBar } from './components/TopBar';
import { ViewportView } from './components/ViewportView';
import { LayoutWorkspace } from './components/LayoutWorkspace';
import { ToastHost } from './components/ToastHost';
import { setLayoutCloudModelLoader } from './components/layoutViewportRenders';
import { DockSlot, SideDock, SideRail, type SideRailItem } from './components/SideRail';
import { WorkspaceFiles } from './components/WorkspaceFiles';
import { LuFolderOpen, LuLibrary } from 'react-icons/lu';
import { ModelObjectBrowser } from './components/ModelObjectBrowser';
import { ExtensionManager } from './extensions/ExtensionManager';
import { browserRunsExtensions, createBrowserExtensionPlatform, type ExtensionRuntimeSources, type AccountExtensionStorage } from './extensions/browserExtensionPlatform';
import { EXTENSIONS_RAIL_ID, useExtensionWorkspace, type ExtensionsPanelId } from './extensions/useExtensionWorkspace';
import { ExtensionRuns } from './extensions/ExtensionActivity';
import { ExtensionPrintDialog, PrintPrompts } from './extensions/extensionPrint';
import { isExtensionRailId } from './extensions/extensionContributions';
import { ExtensionTabs } from './extensions/extensionTabs';
import { sessionExtensionDocuments, sessionExtensionUnits } from './extensions/extensionDocuments';
import { sessionExtensionTools } from './extensions/extensionTools';
import { markDesktopShell, syncDesktopTitleBar } from './desktopShell';
import { allowOpeningDocument, desktopUpdates } from './desktopUpdates';
import { DesktopUpdates } from './components/DesktopUpdates';
import { WindowControls } from './components/WindowControls';
import { DocumentSession, type DocumentTab, type ModelTab } from './session';
import { loadRefreshImages, type RefreshImageStore } from './refreshImages';
import { paintLoading } from './documentLoading';
import { WorkspaceLoading } from './components/WorkspaceLoading';
import { loadNativeRefresh, type NativeRefreshProgress, type NativeRefreshSession } from './nativeRefresh';
import { useGlobalKeys } from './useGlobalKeys';
import { useModelClipboard } from './modelClipboard';
import { useProductUsage } from './usage';
import { CloudSession, cloudProfileComplete, type CloudAccountStore, type CloudBillingStore, type CloudFilesApi, type CloudFile, type CloudProfileStore, type UsageSink } from '@pushform/cloud';
import { defaultLayoutRecoveryStore } from '@pushform/io';
import { accountRecoveryStore, accountSessionStorage } from './accountPersistence';
import { SignInScreen } from './components/SignInScreen';
import { ProfileScreen } from './components/ProfileForm';
import { ProfileContext, useProfileState } from './profileContext';
import { AccountContext, useAccountState } from './accountContext';
import { BillingContext } from './billingContext';
import { DeletionBanner } from './components/AccountLifecycle';
import { useAccountAutoText } from './accountAutoText';
import type { BuildInfo } from './buildInfo';
import { CloudHome } from './components/CloudHome';
import { CloudAutosave } from './cloudAutosave';
import { renderCloudThumbnail } from './cloudThumbnails';
import { ThumbnailService } from './thumbnailService';
import { ThumbnailContext } from './useThumbnails';
import { DocumentLoading } from './components/DocumentLoading';
import { cloudLocation, openCloudDocument } from './cloudDocuments';
import { forgetCloudRecents, readCloudRecents, recordCloudRecent, updateCloudRecent } from './cloudRecents';
import { Chat, DockedPanel, HOME_SCOPE, Popover, RequestsClient, type ClonedDocument, type CloneRequest, type Handoff, type ScreenInfo } from '@pushform/requests-ui';
import { PiTreeView } from 'react-icons/pi';
import { RiChatAiLine } from 'react-icons/ri';

/** Trial chrome lives in its own chunk, imported only when a host passes `trial` (production bundles never run it). */

/** Where the feature request pipeline backend lives; the host resolves it from its environment. */
export interface RequestsConfig {
  /** Base URL of the `fr-conversation` function, e.g. `${SUPABASE_URL}/functions/v1/fr-conversation`. */
  readonly baseUrl: string;
  /** The project's publishable (anon) key, sent as `apikey`; never a server key. */
  readonly apikey: string;
  /** The Supabase region the backend runs in, normally the database's (e.g. `us-east-1`); absent lets Supabase pick the nearest. */
  readonly region?: string | undefined;
}

export interface AppProps {
  readonly commons?: CommonsOpeningConfig | undefined;
  /** Provide a pre-built instance (tests, desktop); otherwise one is created after sign-in. */
  readonly app?: AppInstance | undefined;
  readonly cloud?: CloudSession | undefined;
  readonly cloudFiles?: CloudFilesApi | undefined;
  /** The signed-in account's profile; with it, the workspace waits for a completed signup step. */
  readonly profiles?: CloudProfileStore | undefined;
  /** Account deletion and file export: the account dialog's sections and the deletion banner. */
  readonly account?: CloudAccountStore | undefined;
  readonly billing?: CloudBillingStore | undefined;
  /** Version, commit and build time of the running bundle, shown by About PushForm; unknown when omitted. */
  readonly buildInfo?: BuildInfo | undefined;
  /** Embedding hosts can choose the first screen; otherwise refresh resumes the account's previous screen. */
  readonly initialScreen?: 'home' | 'workspace' | undefined;
  /** AI Chat backend; without it the entry points stay visible but report that requests are unavailable. */
  readonly requests?: RequestsConfig | undefined;
  /** Optional private measurements of completed document work. */
  readonly activity?: ProjectActivitySink | ((ownerId: string) => ProjectActivitySink) | undefined;
  /** Where product usage events go; without it nothing is recorded. */
  readonly usage?: UsageSink | ((ownerId: string) => UsageSink) | undefined;
  /** The extension runtime's worker sources; without them the extension manager is not offered. */
  readonly extensionRuntime?: ExtensionRuntimeSources | undefined;
  /** Account-bound storage for official extensions; developer extensions remain on this device. */
  readonly extensionStorage?: ((ownerId: string) => AccountExtensionStorage) | undefined;
  /** Says whether the account is PushForm staff; extensions are offered only to staff until they open to everyone. */
  readonly staff?: { isStaff(): Promise<boolean> } | undefined;
}

function platform(): { browser: string; os: string } {
  if (typeof navigator === 'undefined') return { browser: 'unknown', os: 'unknown' };
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return { browser: navigator.userAgent || 'unknown', os: data?.platform || navigator.platform || 'unknown' };
}

function browserLocalStorage(ownerId: string) {
  try { return accountSessionStorage(ownerId, window.localStorage); } catch { return null; }
}
function browserSessionStorage(ownerId: string): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof window === 'undefined' ? null : accountSessionStorage(ownerId, window.sessionStorage);
  } catch {
    return null;
  }
}

/** The editors' docked side panels. */
type SidePanel = 'files' | 'requests' | 'objects' | `extension:${string}` | ExtensionsPanelId;
const DEVELOPER_MODE_KEY = 'pushform:extensions:developer-mode';
function developerModeOn(): boolean {
  try { return localStorage.getItem(DEVELOPER_MODE_KEY) === 'on'; } catch { return false; }
}
const WORKSPACE_SCREEN_KEY = 'pushform:workspace-screen:v1';

/**
 * Required account gate. The document engine is first created after successful sign-in; the workspace stays locked
 * until the account's signup step is complete.
 */
export function App({ app, cloud: supplied, cloudFiles, profiles, account, billing, buildInfo, initialScreen, requests, usage, activity, commons, extensionRuntime, extensionStorage, staff }: AppProps = {}): JSX.Element {

  const [unconfigured] = useState(() => new CloudSession(null));
  const cloud = supplied ?? unconfigured;
  const state = useSyncExternalStore(cloud.subscribe, cloud.getSnapshot);
  const signedIn = state.status === 'signedIn' && state.user !== null;
  const profileState = useProfileState(profiles);
  const profileReady = !profiles || (profileState.status === 'ready' && profileState.ownerId === state.user?.id && cloudProfileComplete(profileState.profile));
  const accountState = useAccountState(account);
  useAccountAutoText(signedIn && profileState.ownerId === state.user?.id ? profileState.profile : null);
  const [lastOwner, setLastOwner] = useState<string | null>(signedIn ? state.user!.id : null);
  const workspaceOwner = signedIn ? state.user!.id : lastOwner;
  useEffect(() => { void cloud.start(); }, [cloud]);
  useEffect(() => syncDesktopTitleBar(), []);
  useEffect(() => markDesktopShell(), []);
  useEffect(() => desktopUpdates()?.start(), []);
  useEffect(() => { if (signedIn) setLastOwner(state.user!.id); }, [signedIn, state.user]);
  const screens = <>
    {workspaceOwner ? <Workspace key={workspaceOwner} ownerId={workspaceOwner} app={app} cloud={cloud} cloudFiles={cloudFiles} buildInfo={buildInfo} initialScreen={initialScreen} requests={requests} activity={typeof activity === 'function' ? activity(workspaceOwner) : activity} usage={typeof usage === 'function' ? usage(workspaceOwner) : usage} commons={commons} extensionRuntime={extensionRuntime} extensionStorage={extensionStorage} staff={staff} locked={!signedIn || !profileReady} /> : null}

    {!signedIn ? <SignInScreen cloud={cloud} state={state} /> : null}
    {signedIn && !profileReady && profiles ? <ProfileScreen cloud={cloud} session={state} profiles={profiles} state={profileState} /> : null}
    {signedIn && profileReady && account && accountState.ownerId === state.user!.id ? <DeletionBanner account={account} state={accountState} /> : null}
  </>;
  const provided = <ProfileContext.Provider value={profiles ?? null}><AccountContext.Provider value={account ?? null}><BillingContext.Provider value={billing ?? null}>{screens}<ToastHost /><WindowControls /></BillingContext.Provider></AccountContext.Provider></ProfileContext.Provider>;
  return provided;
}

type WorkspaceProps = Omit<AppProps, 'usage' | 'activity'> & { activity?: ProjectActivitySink | undefined; usage?: UsageSink | undefined; locked: boolean; ownerId: string };

/**
 * Read the image bytes this browser tab kept for refresh before the document session restores its tabs, so a
 * refreshed model reopens with its textures.
 */
function Workspace(props: WorkspaceProps): JSX.Element | null {
  // Install recovered documents only after the saved account choices are available. Keep an existing session while locked.
  const [started, setStarted] = useState(!props.locked);
  useEffect(() => { if (!props.locked) setStarted(true); }, [props.locked]);
  // Hosts supplying an already-built app have no refresh recovery to defer. Normal startup paints feedback first.
  const [images, setImages] = useState<{ store: RefreshImageStore | undefined; native?: NativeRefreshSession | undefined } | null>(
    () => props.app ? { store: undefined } : null);
  const [progress, setProgress] = useState<NativeRefreshProgress | null>(null);
  useEffect(() => {
    if (images) return;
    let live = true;
    void (async () => {
      // Commit the lightweight screen before storage reads, decoding or document-engine construction.
      await paintLoading();
      if (!live) return;
      const storage = browserSessionStorage(props.ownerId);
      let store: RefreshImageStore | undefined, native: NativeRefreshSession | undefined;
      try {
        [store, native] = await (storage ? Promise.all([
          loadRefreshImages(storage),
          typeof indexedDB === 'undefined' ? undefined : loadNativeRefresh(storage, indexedDB, async current => {
            if (!live) return;
            setProgress(current); await paintLoading();
          }, browserLocalStorage(props.ownerId)),
        ]) : Promise.resolve([undefined, undefined] as const));
      } catch { /* Unavailable recovery falls back to Home. */ }
      if (!live) return;
      setProgress(null);
      await paintLoading();
      if (live) setImages({ store, native });
    })();
    return () => { live = false; };
  }, []); // Read once: the workspace is keyed by its owner.
  return images && started ? <WorkspaceSession {...props} refreshImages={images.store} nativeRefresh={images.native} /> : props.locked ? null : <WorkspaceLoading progress={progress} />;
}

/** Keep the document session in memory while locked; unmount all interactive workspace UI. */
function WorkspaceSession({ app: given, cloud, cloudFiles, buildInfo, initialScreen, requests, usage: usageSink, activity, extensionRuntime, extensionStorage, staff, commons, locked, ownerId, refreshImages, nativeRefresh }: WorkspaceProps & { refreshImages: RefreshImageStore | undefined; nativeRefresh: NativeRefreshSession | undefined }): JSX.Element | null {

  // Home pops the chat down under its header icon; the account email is the requester identity.
  /** Mounted on first open and kept mounted while closed, so the conversation survives closing and reopening. */
  const [requestsPanel, setRequestsPanel] = useState<{ anchor: HTMLElement | null; open: boolean } | null>(null);
  /** One conversation per document tab and one for Home, each mounted the first time it is shown and kept while its tab is open. */
  const chats = useRef(new Set<string>());
  /** Clear Chat raises the counter of the conversation it clears. */
  const [clearSignals, setClearSignals] = useState<Record<string, number>>({});
  /** A clone made from AI Chat, by its tab: its chat opens with the handoff and sends the request that made it. */
  const [handoffs, setHandoffs] = useState<Record<string, Handoff & { request: string }>>({});
  /** The editors' one docked side panel at a time; a document's chat mounts on first open and then only hides. */
  const [sidePanel, setSidePanel] = useState<SidePanel | null>(null);
  const [guidanceBrowserTab, setGuidanceBrowserTab] = useState<string | null>(null);
  const [requestsIcon, setRequestsIcon] = useState<HTMLButtonElement | null>(null);
  const filesOpened = useRef(false);
  const [filesNode] = useState(() => { const node = document.createElement('div'); node.className = 'pf-side-dock-files'; return node; });
  const [objectHost, setObjectHost] = useState<HTMLDivElement | null>(null);
  /** The docked chats render into this one element from a fixed place, so switching editors never remounts them. */
  const [chatNode] = useState(() => { const node = document.createElement('div'); node.className = 'pf-side-dock-chat'; return node; });
  const [requestsClient] = useState(() => requests && cloud
    ? new RequestsClient({ baseUrl: requests.baseUrl, apikey: requests.apikey, region: requests.region, getToken: () => cloud.getAccessToken() }) : null);
  const [recents, setRecents] = useState(() => readCloudRecents(ownerId));
  /** This account's extensions on this device; nothing of theirs runs until one of their contributions is used. */
  const [printPrompts] = useState(() => new PrintPrompts());
  // The platform exists before the document session; extensions reach the session's tabs once it does.
  const sessionRef = useRef<DocumentSession | null>(null);
  /** The extension tabs open in the tab strip; an extension's `ui.open` and its selection calls reach them from the platform. */
  const [extensionTabs] = useState(() => extensionRuntime ? new ExtensionTabs({
    activateDocument: (id) => { sessionRef.current?.activate(id); },
    isOpen: (id) => sessionRef.current?.tabs.some(tab => tab.id === id) ?? false,
  }) : null);
  const [inspectorReveal, setInspectorReveal] = useState<{ target: string; seq: number } | null>(null);
  const [extensions] = useState(() => extensionRuntime
    ? createBrowserExtensionPlatform({ ownerId, sources: extensionRuntime, printPrompts,
      ...(extensionStorage ? { accountStorage:extensionStorage(ownerId) } : {}),
      documents: sessionExtensionDocuments(() => sessionRef.current), units: sessionExtensionUnits(() => sessionRef.current),
      tools: sessionExtensionTools(() => sessionRef.current),
      onToolRequested: request => {
        const entry = extensions?.contributions('modeling').find(item => item.extensionId === request.extensionId && item.id === request.target);
        if (!entry || !sessionRef.current?.activate(request.documentId)) return;
        extensionTabs?.activate(null);
        void extensionRuns?.start(entry, request.documentId);
      },
      openUi: request => {
        if (request.kind === 'inspector') {
          sessionRef.current?.activate(request.documentId); extensionTabs?.activate(null);
          useAppStore.setState({ openPanel: 'entityInfo' });
          setInspectorReveal(previous => ({ target: request.target, seq: (previous?.seq ?? 0) + 1 }));
        } else extensionTabs?.openRequest(extensions!, request);
      },
      onSelectionShown: (extensionId, documentId) => extensionTabs?.selectionShown(extensionId, documentId) }) : null);
  const [extensionRuns] = useState(() => extensions ? new ExtensionRuns(extensions) : null);
  /** The Extensions window, for Home; beside an editor the Extensions side panel shows the manager instead. */
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  useEffect(() => {
    if (!extensions) return;
    void extensions.load();
    return () => { void extensions.stopAll(); };
  }, [extensions]);
  // Extensions are offered to staff first; installed ones still run for whoever installed them. Null until decided.
  const [extensionsOffered, setExtensionsOffered] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setExtensionsOffered(staff ? null : false);
    void staff?.isStaff().then((yes) => { if (live) setExtensionsOffered(yes); });
    return () => { live = false; };
  }, [staff, ownerId]);
  const openExtensionsWindow = extensions && extensionsOffered ? () => setExtensionsOpen(true) : undefined;
  /** Beside an editor, Manage extensions, View ▸ Extensions and command search open the Extensions side panel. */
  const openExtensionsPanel = extensions && extensionsOffered ? () => { setGuidanceBrowserTab(null); setSidePanel(EXTENSIONS_RAIL_ID); } : undefined;
  const extensionPrint = extensions ? <ExtensionPrintDialog prompts={printPrompts} /> : null;
  const extensionManager = extensions && extensionsOpen
    ? <ExtensionManager platform={extensions} available={browserRunsExtensions()} developerModeAllowed developerModeOn={developerModeOn()}
        onClose={() => setExtensionsOpen(false)} />
    : null;
  const [owned] = useState<AppInstance | null>(() => (given ? null : createApp({ demo: false })));
  const app = given ?? owned!;
  const [session] = useState(
    () => new DocumentSession(
      app,
      () => createApp({ demo: false, expose: false }),
      !given,
      accountRecoveryStore(ownerId, defaultLayoutRecoveryStore()),
      given ? null : browserSessionStorage(ownerId),
      refreshImages,
      nativeRefresh,
      activity,
    ),
  );
  const [commonsShown, setCommonsShown] = useState(false);
  const [commonsVisited, setCommonsVisited] = useState(false);
  const [commonsPicker, setCommonsPicker] = useState<ModelTab | null>(null);
  const [commonsIntent, setCommonsIntent] = useState(() => commons?.intent ?? null);
  sessionRef.current = session;
  const [home, setHome] = useState(() => {
    if (initialScreen) return initialScreen === 'home';
    if (given || !session.restoredForRefresh) return true;
    try { return browserSessionStorage(ownerId)?.getItem(WORKSPACE_SCREEN_KEY) !== 'workspace'; }
    catch { return true; }
  });
  useEffect(() => {
    if (given || locked) return;
    try { browserSessionStorage(ownerId)?.setItem(WORKSPACE_SCREEN_KEY, home ? 'home' : 'workspace'); }
    catch { /* Storage may be blocked or full; navigation still works for this page. */ }
  }, [given, locked, ownerId, home]);
  const owner = (): string | null => cloud?.getSnapshot().status === 'signedIn' && cloud.getSnapshot().user?.id === ownerId ? ownerId : null;
  const [cloudModelSaves, setCloudModelSaves] = useState(0);
  // Saved documents refresh their Home thumbnail.
  const [thumbnails] = useState(() => cloudFiles ? new ThumbnailService({ api: cloudFiles, ownerId, active: () => owner() === ownerId,
    render: file => renderCloudThumbnail(cloudFiles, session, ownerId, file) }) : undefined);
  const [autosave] = useState(() => cloudFiles ? new CloudAutosave(cloudFiles, session, owner,
    (saved) => {
      setRecents(updateCloudRecent(ownerId, saved.file)); if (saved.file.kind === 'model') setCloudModelSaves(count => count + 1);
      thumbnails?.saved(saved.file);
    }, 1200, false) : undefined);
  // Views of cloud models render from the referenced revision's bytes, fetched only when needed.
  useEffect(() => {
    setLayoutCloudModelLoader(cloudFiles ? async target => (await cloudFiles.openRevision(target.revisionId)).bytes : null);
    return () => setLayoutCloudModelLoader(null);
  }, [cloudFiles]);
  useEffect(() => () => thumbnails?.dispose(), [thumbnails]);
  useEffect(() => { thumbnails?.setEnabled(!locked); }, [thumbnails, locked]);
  useEffect(() => () => autosave?.dispose(), [autosave]);
  useEffect(() => { autosave?.setEnabled(!locked); }, [autosave, locked]);
  useEffect(() => { if (!home) setRequestsPanel(current => current?.open ? { ...current, open: false } : current); }, [home]);
  useEffect(() => {
    const sync = (): void => { autosave?.setOnline(navigator.onLine); if (navigator.onLine) thumbnails?.reconnect(); };
    sync(); window.addEventListener('online', sync); window.addEventListener('offline', sync);
    return () => { window.removeEventListener('online', sync); window.removeEventListener('offline', sync); };
  }, [autosave, thumbnails]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent): void => {
      if (autosave?.hasPending()) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [autosave]);
  useSyncExternalStore(session.subscribe, () => session.revision);
  const commonsOpening = !locked && commonsIntent ? <CommonsOpening intent={commonsIntent} filesUrl={commons?.filesUrl} cloud={cloud} session={session}
    done={() => { setCommonsIntent(null); commons?.handled(); }} opened={() => setHome(false)} /> : null;
  const active = session.active;
  useEffect(() => { setCommonsShown(false); }, [session.activeId]);
  const modelApp = active.type === 'model' ? active.app : app;
  const extensionWorkspace = useExtensionWorkspace({ platform: extensions, runs: extensionRuns, tabs: extensionTabs, ownerId, active: home || locked ? null : active,
    openTabs: session.tabs.map(tab => tab.id), sidePanel,
    openPanel: id => setSidePanel(id), closePanel: () => { setGuidanceBrowserTab(null); setSidePanel(null); },
    manager: { offered: extensionsOffered, available: browserRunsExtensions(), developerModeOn: developerModeOn() } });
  useGlobalKeys(modelApp, active.type === 'model' && !locked && !home && !commonsShown && !commonsPicker && !extensionWorkspace.tabView);
  useModelClipboard(modelApp, active.type === 'model' ? active : null, active.type === 'model' && !locked && !home && !commonsShown && !commonsPicker && !extensionWorkspace.tabView);
  useEffect(() => () => session.dispose(), [session]);
  // Product usage events, with AI Chat counted as open in whichever placement shows it.
  const usage = useProductUsage(usageSink, buildInfo, session,
    { locked, home, helpOpen: home ? !!requestsPanel?.open : sidePanel === 'requests', activeId: active.id });
  /** A Layout document shown for the first time opens the Object browser, unless another panel is open. */
  const shownLayouts = useRef(new Set<string>());
  useEffect(() => {
    if (locked || home || active.type !== 'layout' || shownLayouts.current.has(active.id)) return;
    shownLayouts.current.add(active.id);
    setSidePanel(current => current ?? 'objects');
  }, [locked, home, active.id, active.type]);
  useEffect(() => {
    if (given || typeof window === 'undefined') return;
    const target = window as Window & { pushform?: Record<string, unknown> };
    if (locked || home) { delete target.pushform; return; }
    target.pushform = {
      app: modelApp, document: modelApp.document, toolManager: modelApp.toolManager,
      viewport: modelApp.viewport, keymap: modelApp.keymap, kernel: modelApp.kernel,
      inference: modelApp.inference, store: modelApp.store,
      session,
      scripts: session.scripts,
      commands: session.activeCommands,
    };
    return () => { if (target.pushform?.session === session) delete target.pushform; };
  }, [given, session, active.id, modelApp, locked, home]);
  /**
   * AI Chat's publishing dialog: opened from a publication card with the card's values. `made` records the publication
   * (even one whose collections failed) so closing the dialog reports it.
   */
  const [chatPublication, setChatPublication] = useState<{ snapshot: PublishingSnapshot; preset: PublicationPreset; auto: boolean;
    made: { modelId: string; failures: readonly string[] } | null; resolve(made: { modelId: string; failures: readonly string[] } | null): void } | null>(null);
  const publishingForChat = useMemo(() => (autosave && cloudFiles ? chatPublishing({ files: cloudFiles, saves: autosave, commons,
    openPublishing: (snapshot, preset, auto) => new Promise(resolve => setChatPublication({ snapshot, preset, auto, made: null, resolve })) }) : undefined),
  [autosave, cloudFiles, commons?.account]);
  if (locked) return null;
  const accountEmail = cloud?.getSnapshot().user?.email ?? '';
  const screenOf = (tab: DocumentTab | null): ScreenInfo => ({ editor: tab ? tab.type : 'home', ...(tab ? { documentType: tab.type } : {}),
    build: { version: buildInfo?.version ?? 'unknown', commit: buildInfo?.commit ?? 'unknown' }, ...platform() });
  /** The Home header icon toggles the pop-down. */
  const toggleRequests = (anchor: HTMLElement | null): void =>
    setRequestsPanel(current => current?.open ? { ...current, open: false } : { anchor, open: true });
  const closeRequests = (): void => setRequestsPanel(current => current ? { ...current, open: false } : null);
  /** A rail icon toggles its panel and replaces any other; `help.requests` only opens the chat. */
  const showSidePanel = (id: SidePanel, mode: 'toggle' | 'open'): void =>
    setSidePanel(current => current === id && mode === 'toggle' ? null : id);
  const toggleSidePanel = (id: string): void => {
    setGuidanceBrowserTab(null);
    if (isExtensionRailId(id) || id === EXTENSIONS_RAIL_ID) extensionWorkspace.toggleRail(id);
    else if (id === 'files' || id === 'requests' || id === 'objects') showSidePanel(id, 'toggle');
  };
  const closeSidePanel = (): void => { setGuidanceBrowserTab(null); setSidePanel(null); };
  /** Home's conversation pops down under its icon; each document's docks beside its editor. */
  const chatKey = home ? HOME_SCOPE : active.id;
  if (home ? requestsPanel?.open : sidePanel === 'requests') chats.current.add(chatKey);
  for (const key of chats.current) if (key !== HOME_SCOPE && !session.tabs.some(tab => tab.id === key)) chats.current.delete(key);
  /** Clear Chat: the active document's conversation starts over, and the chat opens on the greeting. */
  const clearChat = (): void => {
    chats.current.add(chatKey);
    setClearSignals(current => ({ ...current, [chatKey]: (current[chatKey] ?? 0) + 1 }));
    showSidePanel('requests', 'open');
  };
  /**
   * Clone a document the requester confirmed on a chat card: the copy opens in a new, active tab, unsaved, headed for the
   * original's project and folder, and its own chat takes over from the handoff.
   */
  const cloneFromChat = async (source: DocumentTab, request: CloneRequest): Promise<ClonedDocument> => {
    if (!allowOpeningDocument()) throw new Error('A downloaded update must be installed before another document opens.');
    const location = cloudLocation(source.identity);
    let draft = source.cloudDraft?.projectId ? { projectId: source.cloudDraft.projectId, folderId: source.cloudDraft.folderId ?? null } : undefined;
    if (location) {
      const head = cloudFiles ? await cloudFiles.head(location.fileId).catch(() => null) : null;
      draft = { projectId: head?.file.project_id ?? location.projectId, folderId: head?.file.folder_id ?? null };
    }
    const tab = await session.cloneDocument(source.id, request.name, draft);
    const plain = (name: string): string => name.replace(/\.(pfl?)$/i, '');
    setHandoffs(current => ({ ...current, [tab.id]: { from: plain(source.name), summary: request.summary, request: request.request } }));
    chats.current.add(tab.id);
    showSidePanel('requests', 'open');
    return { name: plain(tab.name), show: () => { if (session.tabs.includes(tab)) session.activate(tab.id); } };
  };
  const chatPanel = (key: string, client: RequestsClient): JSX.Element => {
    const tab = key === HOME_SCOPE ? null : session.tabs.find(item => item.id === key) ?? null;
    // A saved document resumes its conversation after a reload; an unsaved one keeps it for the session.
    const scope = !tab ? HOME_SCOPE : tab.identity ? `document:${tab.identity}` : `tab:${tab.id}`;
    return <Chat key={key} placement={tab ? 'docked' : 'popover'} client={client} account={{ id: ownerId, email: accountEmail }} screen={screenOf(tab)} scope={scope}
      documentId={tab ? cloudLocation(tab.identity)?.fileId : undefined}
      anchor={requestsPanel?.anchor ?? null} onClose={closeRequests}
      open={key === chatKey && (tab ? sidePanel === 'requests' : !!requestsPanel?.open)}
      documentTools={tab ? () => documentToolsFor(session, tab, panel => { if (panel === 'objects' && sidePanel === 'requests') setGuidanceBrowserTab(tab.id); else showSidePanel(panel, 'open'); }, cloneFromChat, publishingForChat) : undefined}
      handoff={handoffs[key]} onHandoffStarted={() => setHandoffs(({ [key]: _used, ...rest }) => rest)} captureScreenshot={tab ? () => captureRequestScreenshot(session, tab) : undefined} onMessage={() => usage?.record('help_message')} clearSignal={clearSignals[key] ?? 0} />;
  };
  const panel = requestsPanel ? (requestsClient
    ? chats.current.has(HOME_SCOPE) ? chatPanel(HOME_SCOPE, requestsClient) : null
    : <RequestsUnavailable anchor={requestsPanel.anchor} open={requestsPanel.open} onClose={closeRequests} />) : null;
  const documentChats = [...chats.current].filter(key => key !== HOME_SCOPE);
  const dockedRequests = !documentChats.length ? null : requestsClient
    ? <>{documentChats.map(key => chatPanel(key, requestsClient))}</>
    : <RequestsUnavailable placement="docked" anchor={requestsIcon} open={sidePanel === 'requests'} onClose={closeSidePanel} />;
  if (sidePanel === 'files') filesOpened.current = true;
  const railItems: SideRailItem[] = [
    { id: 'files', label: 'Files', icon: <LuFolderOpen aria-hidden="true" /> },
    { id: 'requests', label: 'AI Chat', icon: <RiChatAiLine aria-hidden="true" />, ref: setRequestsIcon },
    { id: 'objects', label: 'Object browser', icon: <PiTreeView aria-hidden="true" /> },
    { id: 'commons', label: 'Commons', icon: <LuLibrary aria-hidden="true" /> },
    ...extensionWorkspace.railItems,
  ];
  /** An extension panel that is no longer available (turned off, or not for this editor) counts as closed. */
  const shownPanel = sidePanel && (isExtensionRailId(sidePanel) || sidePanel === EXTENSIONS_RAIL_ID) && !extensionWorkspace.shown ? null : sidePanel;
  /** The rail and its dock open the editor area, in the right-hand panels' band between tool row and status bar. */
  const companionBrowser = guidanceBrowserTab === active.id && sidePanel === 'requests';
  const browserVisible = sidePanel === 'objects' || companionBrowser;
  const saveStatus = commonsShown ? <span className="pf-local-file-status">Commons</span> : autosave ? <AutosaveIndicator autosave={autosave} session={session} files={cloudFiles} tab={active}
    onSave={() => session.activeCommands.tryExecute('file.save')} onSaveCopy={() => session.activeCommands.tryExecute('file.saveAs')}/>
    : <span className="pf-local-file-status">{session.isDirty(active) ? 'Unsaved changes' : active.identity ? 'File saved' : 'Not saved yet'}</span>;
  const sideBar = <>
    <SideRail items={railItems} active={commonsShown ? 'commons' : shownPanel} onToggle={id => { if (id === 'commons') { setCommonsVisited(true); setCommonsShown(true); } else { setCommonsShown(false); toggleSidePanel(id); } }} />
    <SideDock open={shownPanel !== null}>
      <DockSlot node={filesNode} attached={sidePanel === 'files'} />
      <DockSlot node={chatNode} attached={sidePanel === 'requests'} />
      {/* Layout portals its browser into this element; the model's renders here directly. */}
      <div ref={setObjectHost} className={`pf-side-dock-objects${companionBrowser ? ' is-guidance-companion' : ''}`} hidden={!browserVisible}>
        {active.type === 'model' && browserVisible ? <ModelObjectBrowser key={active.id} /> : null}
      </div>
      {extensionWorkspace.panel}
    </SideDock>
  </>;
  /** An extension tab in front fills the editor area; the viewport and its panels stay mounted behind it. */
  const extensionTab = extensionWorkspace.tabView ? <div className="pf-xtab-host">{extensionWorkspace.tabView}</div> : null;
  const removeStarter = (): void => {
    const starter = session.tabs.find(tab => tab.id === 'tab-1' && !tab.identity && !session.isDirty(tab));
    if (!given && starter && session.tabs.length > 1) session.close(starter.id, true);
  };
  const open = async (file: CloudFile): Promise<void> => {
    if (!cloudFiles || !allowOpeningDocument()) return;
    const finishOpen = async (): Promise<void> => {
      await openCloudDocument(cloudFiles, session, file, owner);
      setRecents(recordCloudRecent(ownerId, file)); removeStarter(); setHome(false);
    };
    if (!file.is_template && tabFor(file.id)) await finishOpen();
    else await session.loading.run(file.name, 'Opening document…', finishOpen);
  };
  // Home's rename, move and Trash actions reach the open editors and the recents list.
  const forgetRecents = (ids: string[]): void => setRecents(forgetCloudRecents(ownerId, ids));
  const tabFor = (fileId: string) => session.tabs.find(tab => { const location = cloudLocation(tab.identity); return location?.ownerId === ownerId && location.fileId === fileId; });
  const renamed = (fileId: string, name: string): void => { const tab = tabFor(fileId); if (tab) session.rename(tab.id, name); };
  const moved = (fileId: string, projectId: string): void => {
    const tab = tabFor(fileId), location = tab && cloudLocation(tab.identity);
    if (!tab || !location || tab.savedContent === undefined) return;
    // Only the project in the identity changes; the saved baseline stays, so dirty work stays dirty.
    const identity = `cloud:${ownerId}:${projectId}:${location.fileId}:${location.revisionId}`;
    if (tab.type === 'model') session.markModelSaved(tab.id, undefined, identity, tab.savedContent);
    else session.markLayoutSaved(tab.id, undefined, identity, tab.savedContent);
  };
  const create = async (kind: 'model' | 'layout', name: string, projectId?: string, folderId?: string | null): Promise<void> => {
    if (!autosave) throw new Error('Cloud storage is unavailable. Try again later.');
    if (!allowOpeningDocument()) return;
    const tab = kind === 'model' ? session.newModel() : session.newLayout('graph-a4-landscape');
    tab.name = name; autosave.track(tab, projectId, projectId ? folderId ?? null : null); removeStarter(); setHome(false);
  };
  /** Every document with changes is saved before restarting to update. */
  const feedback = <>
    {commonsOpening}
    <DesktopUpdates saveAll={async () => { session.flushRefreshPersistence(); await session.settledNativeRecovery(); if (session.tabs.some(tab => (session.isDirty(tab) || autosave?.needsSave(tab)) && session.localSaveState(tab) !== 'saved')) throw new Error('Local recovery could not be confirmed. Save a cloud version or export a file before updating.'); }} />
    <DocumentLoading loading={session.loading} />
  </>;
  if (home) return <ThumbnailContext.Provider value={thumbnails}>
    <CloudHome localSession={session} onLocalOpened={() => setHome(false)} onCommons={() => { setHome(false); setCommonsVisited(true); setCommonsShown(true); }} api={cloudFiles} cloud={cloud} recents={recents} ownerId={ownerId} buildInfo={buildInfo}
      openTabs={session.tabs.filter(tab => tab.id !== 'tab-1' || tab.identity || session.isDirty(tab))}
      onResume={tab => { session.activate(tab.id); setHome(false); }} onOpen={open} onCreate={create} onRequests={toggleRequests} requestsOpen={requestsPanel?.open ?? false}
      onForgetRecents={forgetRecents} onRenamed={renamed} onMoved={moved} onExtensions={openExtensionsWindow} />
    {panel}
    {extensionManager}
    {extensionPrint}
    {feedback}
  </ThumbnailContext.Provider>;
  return (
    <ThumbnailContext.Provider value={thumbnails}><AppContext.Provider value={modelApp}><ExtensionInspectorContext.Provider value={{ platform: extensions, documentId: active.type === 'model' && !locked ? active.id : null, ownerId, reveal: inspectorReveal }}>
      <div className={`pf-app${commonsShown ? ' pf-commons-active' : ''}`}>
        <TopBar onModelTab={() => setCommonsShown(false)} commons={commons} commonsOpen={commonsVisited} commonsActive={commonsShown}
          onCloseCommons={() => { setCommonsShown(false); setCommonsVisited(false); }} onBrowseCommons={() => { setCommonsVisited(true); setCommonsShown(true); }} session={session} cloud={cloud} cloudFiles={cloudFiles} buildInfo={buildInfo} autosave={autosave} onHome={() => setHome(true)}
          onRequests={() => toggleSidePanel('requests')} onObjects={() => toggleSidePanel('objects')} onClearChat={requestsClient ? clearChat : undefined}
          onExtensions={openExtensionsPanel} extensionTabs={extensionWorkspace.tabStrip} />
        {commonsVisited && <div className="pf-commons-tab" hidden={!commonsShown}><CommonsBrowser account={commons?.account} filesUrl={commons?.filesUrl} session={session} onClose={() => setCommonsShown(false)} onOpened={() => setCommonsShown(false)} /></div>}
        {chatPublication && commons?.account ? <PublishSnapshot account={commons.account} filesUrl={commons.filesUrl} snapshot={chatPublication.snapshot}
          preset={chatPublication.preset} autoPublish={chatPublication.auto} onPublication={(modelId, failures) => { chatPublication.made = { modelId, failures }; }}
          onClose={() => { setChatPublication(null); chatPublication.resolve(chatPublication.made); }} /> : null}
        {commonsPicker && createPortal(<div className="pf-modal-backdrop"><section className="pf-modal pf-commons-picker" role="dialog" aria-modal="true" aria-label="Import from Commons"><CommonsBrowser account={commons?.account} filesUrl={commons?.filesUrl} session={session} target={commonsPicker} onClose={() => setCommonsPicker(null)} onOpened={() => setCommonsPicker(null)} /></section></div>, document.body)}
        {extensionManager}
        {extensionPrint}
        {active.type === 'model' ? (
          <>
            <MainToolbar extensionTools={extensionWorkspace.toolbarItems} onCommons={() => { if (active.type === 'model') setCommonsPicker(active); }} />
            <div className={`pf-main${extensionTab ? ' has-xtab' : ''}`}>
              {sideBar}
              {extensionTab}
              <ViewportView key={active.id} />
              <PanelHost />
              <RightStrip />
            </div>
            <StatusBar saveStatus={saveStatus} units={commonsShown ? undefined : active.app.document.doc.state.meta.units.lengthUnit}
              hint={commonsShown ? 'Browse community models. Open a document tab to keep working.' : undefined}/>
          </>
        ) : (
          <LayoutWorkspace key={active.id} tab={active} session={session} leading={sideBar} editorOverride={extensionTab} saveStatus={saveStatus} catalogActive={commonsShown}
            objectBrowser={{ host: objectHost, open: browserVisible }}

            cloud={cloudFiles ? { api: cloudFiles, owner, session, saves: cloudModelSaves } : undefined} />
        )}
      </div>
      {filesOpened.current ? createPortal(<WorkspaceFiles api={cloudFiles} open={sidePanel === 'files'} onOpen={open}
        onRenamed={renamed} onMoved={moved} onForgetRecents={forgetRecents} />, filesNode) : null}
      {dockedRequests ? createPortal(dockedRequests, chatNode) : null}
      {extensionWorkspace.activity}
      {feedback}
    </ExtensionInspectorContext.Provider></AppContext.Provider></ThumbnailContext.Provider>
  );
}

/** Shown when the host supplied no requests backend: the entry point exists, the service does not. */
function RequestsUnavailable({ anchor, open, onClose, placement = 'popover' }: {
  anchor: HTMLElement | null; open: boolean; onClose: () => void; placement?: 'popover' | 'docked';
}): JSX.Element {
  const Shell = placement === 'docked' ? DockedPanel : Popover;
  // Close hides the panel it sits in; focus goes back to the icon rather than falling to the page.
  const close = (): void => { onClose(); if (anchor?.isConnected) anchor.focus(); };
  return <Shell label="AI Chat" className="pf-requests-unavailable" anchor={anchor} open={open} onClose={onClose}>
    <p role="alert">AI Chat is unavailable for this installation. Please contact the administrator.</p>
    <div className="pf-modal-actions"><button type="button" data-autofocus onClick={close}>Close</button></div>
  </Shell>;
}

export default App;
