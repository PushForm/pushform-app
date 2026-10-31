// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import { createPortal } from 'react-dom';
import { CommonsOpening, type CommonsOpeningConfig } from './components/CommonsOpening';
import { AppContext } from './AppContext';
import { createApp } from './bootstrap';
import type { AppInstance } from './bootstrap';
import { MainToolbar } from './components/MainToolbar';
import { documentToolsFor } from './documentTools';
import { captureRequestScreenshot } from './requestScreenshot';
import { PanelHost } from './components/PanelHost';
import { RightStrip } from './components/RightStrip';
import { StatusBar } from './components/StatusBar';
import { TopBar } from './components/TopBar';
import { ViewportView } from './components/ViewportView';
import { LayoutWorkspace } from './components/LayoutWorkspace';
import { ToastHost } from './components/ToastHost';
import { setLayoutCloudModelLoader } from './components/layoutViewportRenders';
import { DockSlot, SideDock, SideRail, type SideRailItem } from './components/SideRail';
import { WorkspaceFiles } from './components/WorkspaceFiles';
import { LuFolderOpen } from 'react-icons/lu';
import { ModelObjectBrowser } from './components/ModelObjectBrowser';
import { ExtensionManager } from './extensions/ExtensionManager';
import { browserRunsExtensions, createBrowserExtensionPlatform, type ExtensionRuntimeSources } from './extensions/browserExtensionPlatform';
import { ExtensionRuns } from './extensions/ExtensionActivity';
import { ExtensionPrintDialog, PrintPrompts } from './extensions/extensionPrint';
import { isExtensionPanelId } from './extensions/extensionContributions';
import { useExtensionWorkspace } from './extensions/useExtensionWorkspace';
import { markDesktopShell, syncDesktopTitleBar } from './desktopShell';
import { allowOpeningDocument, desktopUpdates } from './desktopUpdates';
import { DesktopUpdates } from './components/DesktopUpdates';
import { DocumentSession, type DocumentTab } from './session';
import { loadRefreshImages, type RefreshImageStore } from './refreshImages';
import { paintLoading } from './documentLoading';
import { WorkspaceLoading } from './components/WorkspaceLoading';
import { loadNativeRefresh, type NativeRefreshProgress, type NativeRefreshSession } from './nativeRefresh';
import { useGlobalKeys } from './useGlobalKeys';
import { useModelClipboard } from './modelClipboard';
import { useProductUsage } from './usage';
import { CloudSession, cloudProfileComplete, type CloudAccountStore, type CloudFilesApi, type CloudFile, type CloudProfileStore, type UsageSink } from '@pushform/cloud';
import { defaultLayoutRecoveryStore } from '@pushform/io';
import { accountRecoveryStore, accountSessionStorage } from './accountPersistence';
import { SignInScreen } from './components/SignInScreen';
import { ProfileScreen } from './components/ProfileForm';
import { ProfileContext, useProfileState } from './profileContext';
import { AccountContext, useAccountState } from './accountContext';
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
import { Chat, DockedPanel, HOME_SCOPE, Popover, RequestsClient, type ScreenInfo } from '@pushform/requests-ui';
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
  /** Version, commit and build time of the running bundle, shown by About PushForm; unknown when omitted. */
  readonly buildInfo?: BuildInfo | undefined;
  /** Embedding hosts can choose the first screen; otherwise refresh resumes the account's previous screen. */
  readonly initialScreen?: 'home' | 'workspace' | undefined;
  /** AI Chat backend; without it the entry points stay visible but report that requests are unavailable. */
  readonly requests?: RequestsConfig | undefined;
  /** Where product usage events go; without it nothing is recorded. */
  readonly usage?: UsageSink | undefined;
  /** The extension runtime's worker sources; without them the extension manager is not offered. */
  readonly extensionRuntime?: ExtensionRuntimeSources | undefined;
  /** Says whether the account is PushForm staff; extensions are offered only to staff until they open to everyone. */
  readonly staff?: { isStaff(): Promise<boolean> } | undefined;
}

function platform(): { browser: string; os: string } {
  if (typeof navigator === 'undefined') return { browser: 'unknown', os: 'unknown' };
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return { browser: navigator.userAgent || 'unknown', os: data?.platform || navigator.platform || 'unknown' };
}

function browserSessionStorage(ownerId: string): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof window === 'undefined' ? null : accountSessionStorage(ownerId, window.sessionStorage);
  } catch {
    return null;
  }
}

/** The editors' docked side panels. */
type SidePanel = 'files' | 'requests' | 'objects' | `extension:${string}`;
const WORKSPACE_SCREEN_KEY = 'pushform:workspace-screen:v1';

/**
 * Required account gate. The document engine is first created after successful sign-in; the workspace stays locked
 * until the account's signup step is complete.
 */
export function App({ app, cloud: supplied, cloudFiles, profiles, account, buildInfo, initialScreen, requests, usage, commons }: AppProps = {}): JSX.Element {
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
    {workspaceOwner ? <Workspace key={workspaceOwner} ownerId={workspaceOwner} app={app} cloud={cloud} cloudFiles={cloudFiles} buildInfo={buildInfo} initialScreen={initialScreen} requests={requests} usage={usage} commons={commons} locked={!signedIn || !profileReady} /> : null}
    {!signedIn ? <SignInScreen cloud={cloud} state={state} /> : null}
    {signedIn && !profileReady && profiles ? <ProfileScreen cloud={cloud} session={state} profiles={profiles} state={profileState} /> : null}
    {signedIn && profileReady && account && accountState.ownerId === state.user!.id ? <DeletionBanner account={account} state={accountState} /> : null}
  </>;
  const provided = <ProfileContext.Provider value={profiles ?? null}><AccountContext.Provider value={account ?? null}>{screens}<ToastHost /></AccountContext.Provider></ProfileContext.Provider>;
  return provided;
}

type WorkspaceProps = AppProps & { locked: boolean; ownerId: string };

/**
 * Read the image bytes this browser tab kept for refresh before the document session restores its tabs, so a
 * refreshed model reopens with its textures.
 */
function Workspace(props: WorkspaceProps): JSX.Element | null {
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
          }),
        ]) : Promise.resolve([undefined, undefined] as const));
      } catch { /* Unavailable recovery falls back to Home. */ }
      if (!live) return;
      setProgress(null);
      await paintLoading();
      if (live) setImages({ store, native });
    })();
    return () => { live = false; };
  }, []); // Read once: the workspace is keyed by its owner.
  return images ? <WorkspaceSession {...props} refreshImages={images.store} nativeRefresh={images.native} /> : props.locked ? null : <WorkspaceLoading progress={progress} />;
}

/** Keep the document session in memory while locked; unmount all interactive workspace UI. */
function WorkspaceSession({ app: given, cloud, cloudFiles, buildInfo, initialScreen, requests, usage: usageSink, extensionRuntime, staff, commons, locked, ownerId, refreshImages, nativeRefresh }: WorkspaceProps & { refreshImages: RefreshImageStore | undefined; nativeRefresh: NativeRefreshSession | undefined }): JSX.Element | null {
  // Home pops the chat down under its header icon; the account email is the requester identity.
  /** Mounted on first open and kept mounted while closed, so the conversation survives closing and reopening. */
  const [requestsPanel, setRequestsPanel] = useState<{ anchor: HTMLElement | null; open: boolean } | null>(null);
  /** One conversation per document tab and one for Home, each mounted the first time it is shown and kept while its tab is open. */
  const chats = useRef(new Set<string>());
  /** Clear Chat raises the counter of the conversation it clears. */
  const [clearSignals, setClearSignals] = useState<Record<string, number>>({});
  /** The editors' one docked side panel at a time; a document's chat mounts on first open and then only hides. */
  const [sidePanel, setSidePanel] = useState<SidePanel | null>(null);
  const [guidanceBrowserTab, setGuidanceBrowserTab] = useState<string | null>(null);
  const [requestsIcon, setRequestsIcon] = useState<HTMLButtonElement | null>(null);
  const [filesIcon, setFilesIcon] = useState<HTMLButtonElement | null>(null);
  const filesOpened = useRef(false);
  const [filesNode] = useState(() => { const node = document.createElement('div'); node.className = 'pf-side-dock-files'; return node; });
  const [objectsIcon, setObjectsIcon] = useState<HTMLButtonElement | null>(null);
  const [objectHost, setObjectHost] = useState<HTMLDivElement | null>(null);
  /** The docked chats render into this one element from a fixed place, so switching editors never remounts them. */
  const [chatNode] = useState(() => { const node = document.createElement('div'); node.className = 'pf-side-dock-chat'; return node; });
  const [requestsClient] = useState(() => requests && cloud
    ? new RequestsClient({ baseUrl: requests.baseUrl, apikey: requests.apikey, region: requests.region, getToken: () => cloud.getAccessToken() }) : null);
  const [recents, setRecents] = useState(() => readCloudRecents(ownerId));
  /** This account's extensions on this device; nothing of theirs runs until one of their contributions is used. */
  const [printPrompts] = useState(() => new PrintPrompts());
  const [extensions] = useState(() => extensionRuntime ? createBrowserExtensionPlatform({ ownerId, sources: extensionRuntime, printPrompts }) : null);
  const [extensionRuns] = useState(() => extensions ? new ExtensionRuns(extensions) : null);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  useEffect(() => {
    if (!extensions) return;
    void extensions.load();
    return () => { void extensions.stopAll(); };
  }, [extensions]);
  // Extensions are offered to staff first; installed ones still run for whoever installed them.
  const [extensionsOffered, setExtensionsOffered] = useState(false);
  useEffect(() => {
    let live = true;
    setExtensionsOffered(false);
    void staff?.isStaff().then((yes) => { if (live) setExtensionsOffered(yes); });
    return () => { live = false; };
  }, [staff, ownerId]);
  const openExtensions = extensions && extensionsOffered ? () => setExtensionsOpen(true) : undefined;
  const extensionPrint = extensions ? <ExtensionPrintDialog prompts={printPrompts} /> : null;
  const extensionManager = extensions && extensionsOpen
    ? <ExtensionManager platform={extensions} available={browserRunsExtensions()} developerModeAllowed developerModeOn={localStorage.getItem('pushform:extensions:developer-mode') === 'on'}
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
    ),
  );
  const [commonsIntent, setCommonsIntent] = useState(() => commons?.intent ?? null);
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
    }) : undefined);
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
  const modelApp = active.type === 'model' ? active.app : app;
  useGlobalKeys(modelApp, active.type === 'model' && !locked && !home);
  useModelClipboard(modelApp, active.type === 'model' ? active : null, active.type === 'model' && !locked && !home);
  const extensionWorkspace = useExtensionWorkspace({ platform: extensions, runs: extensionRuns, ownerId, active: home || locked ? null : active,
    openTabs: session.tabs.map(tab => tab.id), sidePanel,
    openPanel: id => setSidePanel(id), closePanel: () => { setGuidanceBrowserTab(null); setSidePanel(null); } });
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
    if (id === 'files' || id === 'requests' || id === 'objects' || isExtensionPanelId(id)) showSidePanel(id, 'toggle');
  };
  const closeSidePanel = (): void => { setGuidanceBrowserTab(null); setSidePanel(null); };
  /** The object browser hides itself on Escape; focus inside it then returns to its rail icon. */
  const closeObjects = (): void => {
    setGuidanceBrowserTab(null);
    const focused = !!objectHost?.contains(document.activeElement);
    setSidePanel(current => current === 'objects' ? null : current);
    if (focused && objectsIcon?.isConnected) objectsIcon.focus();
  };
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
  const chatPanel = (key: string, client: RequestsClient): JSX.Element => {
    const tab = key === HOME_SCOPE ? null : session.tabs.find(item => item.id === key) ?? null;
    // A saved document resumes its conversation after a reload; an unsaved one keeps it for the session.
    const scope = !tab ? HOME_SCOPE : tab.identity ? `document:${tab.identity}` : `tab:${tab.id}`;
    return <Chat key={key} placement={tab ? 'docked' : 'popover'} client={client} account={{ id: ownerId, email: accountEmail }} screen={screenOf(tab)} scope={scope}
      anchor={tab ? requestsIcon : requestsPanel?.anchor ?? null} onClose={tab ? closeSidePanel : closeRequests}
      open={key === chatKey && (tab ? sidePanel === 'requests' : !!requestsPanel?.open)}
      documentTools={tab ? () => documentToolsFor(session, tab, panel => { if (panel === 'objects' && sidePanel === 'requests') setGuidanceBrowserTab(tab.id); else showSidePanel(panel, 'open'); }) : undefined} captureScreenshot={tab ? () => captureRequestScreenshot(session, tab) : undefined} onMessage={() => usage?.record('help_message')} clearSignal={clearSignals[key] ?? 0} />;
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
    { id: 'files', label: 'Files', icon: <LuFolderOpen aria-hidden="true" />, ref: setFilesIcon },
    { id: 'requests', label: 'AI Chat', icon: <RiChatAiLine aria-hidden="true" />, ref: setRequestsIcon },
    { id: 'objects', label: 'Object browser', icon: <PiTreeView aria-hidden="true" />, ref: setObjectsIcon },
    ...extensionWorkspace.railItems,
  ];
  /** An extension panel that is no longer available (turned off, or not for this editor) counts as closed. */
  const shownPanel = sidePanel && isExtensionPanelId(sidePanel) && !extensionWorkspace.shown ? null : sidePanel;
  /** The rail and its dock open the editor area, in the right-hand panels' band between tool row and status bar. */
  const companionBrowser = guidanceBrowserTab === active.id && sidePanel === 'requests';
  const browserVisible = sidePanel === 'objects' || companionBrowser;
  const sideBar = <>
    <SideRail items={railItems} active={shownPanel} onToggle={toggleSidePanel} />
    <SideDock open={shownPanel !== null}>
      <DockSlot node={filesNode} attached={sidePanel === 'files'} />
      <DockSlot node={chatNode} attached={sidePanel === 'requests'} />
      {/* Layout portals its browser into this element; the model's renders here directly. */}
      <div ref={setObjectHost} className={`pf-side-dock-objects${companionBrowser ? ' is-guidance-companion' : ''}`} hidden={!browserVisible}>
        {active.type === 'model' && browserVisible ? <ModelObjectBrowser key={active.id} onClose={closeObjects} /> : null}
      </div>
      {extensionWorkspace.panel}
    </SideDock>
  </>;
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
    <DesktopUpdates saveAll={async () => { await autosave?.saveAll(); }} />
    <DocumentLoading loading={session.loading} />
  </>;
  if (home) return <ThumbnailContext.Provider value={thumbnails}>
    <CloudHome api={cloudFiles} cloud={cloud} recents={recents} ownerId={ownerId} buildInfo={buildInfo}
      openTabs={session.tabs.filter(tab => tab.id !== 'tab-1' || tab.identity || session.isDirty(tab))}
      onResume={tab => { session.activate(tab.id); setHome(false); }} onOpen={open} onCreate={create} onRequests={toggleRequests} requestsOpen={requestsPanel?.open ?? false}
      onForgetRecents={forgetRecents} onRenamed={renamed} onMoved={moved} onExtensions={openExtensions} />
    {panel}
    {extensionManager}
    {extensionPrint}
    {feedback}
  </ThumbnailContext.Provider>;
  return (
    <ThumbnailContext.Provider value={thumbnails}><AppContext.Provider value={modelApp}>
      <div className="pf-app">
        <TopBar session={session} cloud={cloud} cloudFiles={cloudFiles} buildInfo={buildInfo} autosave={autosave} onHome={() => setHome(true)}
          onRequests={() => toggleSidePanel('requests')} onObjects={() => toggleSidePanel('objects')} onClearChat={requestsClient ? clearChat : undefined}
          onExtensions={openExtensions} />
        {extensionManager}
        {extensionPrint}
        {active.type === 'model' ? (
          <>
            <MainToolbar />
            <div className="pf-main">
              {sideBar}
              <ViewportView key={active.id} />
              <PanelHost />
              <RightStrip />
            </div>
            <StatusBar />
          </>
        ) : (
          <LayoutWorkspace key={active.id} tab={active} session={session} leading={sideBar}
            objectBrowser={{ host: objectHost, open: browserVisible, onClose: closeObjects }}
            cloud={cloudFiles ? { api: cloudFiles, owner, session, saves: cloudModelSaves } : undefined} />
        )}
      </div>
      {filesOpened.current ? createPortal(<WorkspaceFiles api={cloudFiles} open={sidePanel === 'files'} onOpen={open}
        onRenamed={renamed} onMoved={moved} onForgetRecents={forgetRecents}
        onClose={() => { closeSidePanel(); filesIcon?.focus(); }} />, filesNode) : null}
      {dockedRequests ? createPortal(dockedRequests, chatNode) : null}
      {extensionWorkspace.activity}
      {feedback}
    </AppContext.Provider></ThumbnailContext.Provider>
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
