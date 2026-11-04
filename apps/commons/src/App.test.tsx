// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { exampleModel } from './catalog.fixture';
import type { CatalogLoader, CatalogModel } from './catalog';
import type { CommonsAccount } from './account';

beforeEach(() => window.history.replaceState(null, '', '/'));
afterEach(cleanup);
it('makes unavailable configuration and an empty published catalog distinct', async () => {
  const view = render(<App loadCatalog={null} />);
  expect(screen.getByRole('status').textContent).toContain('isn’t available yet');
  expect(screen.queryByText('0 models')).toBeNull();
  view.rerender(<App loadCatalog={async () => []} />);
  expect(await screen.findByText('The library is ready for its first models.')).toBeTruthy();
});
it('searches and combines filters, clears them and shows source attribution on cards', async () => {
  const first = exampleModel();
  const second = exampleModel({ id: 'garden-bench', title: 'Garden bench', category: 'Furniture', licenses: [{ ...first.licenses[0]!, name: 'Personal use', commercialUse: 'restricted' }] });
  render(<App loadCatalog={async () => [first, second]} />);
  await screen.findByRole('link', { name: 'View Workshop hinge' });
  expect(screen.getAllByText('From Example Library')).toHaveLength(2);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Commercial use permitted' }));
  expect(screen.queryByRole('link', { name: 'View Garden bench' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Furniture' } });
  expect(screen.getByText('No models match those filters.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(screen.getByRole('link', { name: 'View Garden bench' })).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'hinge' } });
  expect(screen.queryByRole('link', { name: 'View Garden bench' })).toBeNull();
});
it('opens a direct model link with original license notices and creator credits', async () => {
  window.history.replaceState(null, '', '/#models/workshop-hinge');
  render(<App loadCatalog={async () => [exampleModel()]} />);
  expect(await screen.findByRole('heading', { level: 1, name: 'Workshop hinge' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Attribution 3.0 ↗' }).getAttribute('href')).toBe('https://example.com/license');
  expect(screen.getByText('Credit Example Maker.')).toBeTruthy();
  expect(screen.getByText('Original model by Example Maker.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Example Library ↗' }).getAttribute('href')).toBe('https://example.com/model');
  window.history.replaceState(null, '', '/#browse'); fireEvent(window, new Event('hashchange'));
  expect(await screen.findByRole('heading', { name: 'Browse models' })).toBeTruthy();
});
it('shows an unavailable model instead of substituting another catalog item', async () => {
  window.history.replaceState(null, '', '/#models/removed-model');
  render(<App loadCatalog={async () => [exampleModel()]} />);
  expect(await screen.findByText('This model isn’t in the catalog.')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Workshop hinge' })).toBeNull();
});
it('retries a failed request and ignores an obsolete request after a loader change', async () => {
  const loader = vi.fn<CatalogLoader>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);
  const view = render(<App loadCatalog={loader} />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('The library is ready for its first models.')).toBeTruthy();
  let resolveOld!: (models: CatalogModel[]) => void;
  const old: CatalogLoader = () => new Promise((resolve) => { resolveOld = resolve; });
  view.rerender(<App loadCatalog={old} />);
  await screen.findByText('Loading models…');
  view.rerender(<App loadCatalog={async () => []} />);
  await screen.findByText('The library is ready for its first models.');
  resolveOld([exampleModel()]);
  await waitFor(() => expect(screen.queryByRole('link', { name: 'View Workshop hinge' })).toBeNull());
});

it('replaces a broken preview with a labeled fallback', async () => {
  render(<App loadCatalog={async () => [exampleModel({ imageUrl: 'https://example.com/missing.jpg' })]} />);
  const image = await screen.findByRole('img', { name: 'Workshop hinge' });
  fireEvent.error(image);
  expect(screen.getByText('Preview unavailable')).toBeTruthy();
  expect(screen.queryByRole('img', { name: 'Workshop hinge' })).toBeNull();
});

it('shows a disabled server catalog as unavailable rather than an empty catalog or generic failure', async () => {
  const { CommonsUnavailableError } = await import('@pushform/cloud');
  render(<App loadCatalog={async () => {throw new CommonsUnavailableError();}} />);
  await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('isn’t available yet'));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('requires account access for downloads and explains missing file configuration',async()=>{
  window.history.replaceState(null,'','/#models/workshop-hinge');
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const model=exampleModel({files:[{id,name:'hinge.step',format:'STEP',sizeBytes:1234,sha256:'a'.repeat(64)}]});
  const loader=async()=>[model];const view=render(<App loadCatalog={loader} filesUrl="https://files.example"/>);
  expect(await screen.findByText('Sign-in is unavailable in this build.')).toBeTruthy();expect(screen.queryByRole('link',{name:'Download ZIP — hinge.step'})).toBeNull();
  view.rerender(<App loadCatalog={loader}/>);expect(screen.queryByRole('link',{name:'Download ZIP — hinge.step'})).toBeNull();expect(screen.getByText(/Downloads are unavailable in this build/)).toBeTruthy();
});

it('opens public profile routes independently of catalog availability',async()=>{
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';window.history.replaceState(null,'','/#people/'+id);
  render(<App loadCatalog={null}/>);expect(await screen.findByText('Profiles are unavailable in this build.')).toBeTruthy();expect(screen.queryByText('The Commons catalog isn’t available yet.')).toBeNull();
});

const profilePage={profile:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',handle:'example-maker',displayName:'Example Maker',bio:'',avatarUrl:null,links:[]},models:[exampleModel()]};
it('opens a public profile at its handle path and returns hash links from it to the catalog root',async()=>{
  window.history.replaceState(null,'','/u/example-maker');const getByHandle=vi.fn().mockResolvedValue(profilePage);
  render(<App loadCatalog={async()=>[exampleModel()]} account={{profiles:{getByHandle}} as unknown as CommonsAccount}/>);
  expect(await screen.findByRole('heading',{name:'Example Maker'})).toBeTruthy();expect(getByHandle).toHaveBeenCalledWith('example-maker',expect.anything());
  window.history.pushState(null,'','/u/example-maker#models/workshop-hinge');fireEvent(window,new HashChangeEvent('hashchange'));
  expect(await screen.findByRole('heading',{name:'Workshop hinge',level:1})).toBeTruthy();expect(window.location.pathname).toBe('/');expect(window.location.hash).toBe('#models/workshop-hinge');
  window.history.pushState(null,'','/u/example-maker');fireEvent(window,new PopStateEvent('popstate'));expect(await screen.findByRole('heading',{name:'Example Maker'})).toBeTruthy();
});
it('moves older account-ID profile links to the handle path',async()=>{
  window.history.replaceState(null,'','/#people/'+profilePage.profile.id);const get=vi.fn().mockResolvedValue(profilePage);
  render(<App loadCatalog={null} account={{profiles:{get,getByHandle:vi.fn()}} as unknown as CommonsAccount}/>);
  expect(await screen.findByRole('heading',{name:'Example Maker'})).toBeTruthy();await waitFor(()=>expect(window.location.pathname).toBe('/u/example-maker'));expect(window.location.hash).toBe('');
});
const signedIn=(profiles:Record<string,unknown>)=>({session:{subscribe:()=>()=>{},getSnapshot:()=>({user:{id:'user-1'}})},profiles}) as unknown as CommonsAccount;
it('opens the signed-in user’s public profile from My profile and shows Edit profile only on it',async()=>{
  const mine=vi.fn().mockResolvedValue({...profilePage.profile,active:true,version:1});
  const getByHandle=vi.fn().mockImplementation(async(handle:string)=>handle==='example-maker'?profilePage:{profile:{...profilePage.profile,id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',handle:'other-maker',displayName:'Other Maker'},models:[]});
  render(<App loadCatalog={async()=>[]} account={signedIn({mine,getByHandle})}/>);
  await waitFor(()=>expect(screen.getByRole('link',{name:'My profile'}).getAttribute('href')).toBe('/u/example-maker'));
  fireEvent.click(screen.getByRole('link',{name:'My profile'}));expect(window.location.pathname).toBe('/u/example-maker');
  expect(await screen.findByRole('heading',{name:'Example Maker'})).toBeTruthy();
  expect(screen.getByRole('link',{name:'Edit profile'}).getAttribute('href')).toBe('#account');
  window.history.pushState(null,'','/u/other-maker');fireEvent(window,new PopStateEvent('popstate'));
  expect(await screen.findByRole('heading',{name:'Other Maker'})).toBeTruthy();expect(screen.queryByRole('link',{name:'Edit profile'})).toBeNull();
});
it('sends My profile to the profile editor without a visible public profile and hides Edit profile when signed out',async()=>{
  const view=render(<App loadCatalog={async()=>[]} account={signedIn({mine:vi.fn().mockResolvedValue(null)})}/>);
  expect((await screen.findByRole('link',{name:'My profile'})).getAttribute('href')).toBe('#account');view.unmount();
  window.history.replaceState(null,'','/u/example-maker');const mine=vi.fn();
  render(<App loadCatalog={async()=>[]} account={{session:{subscribe:()=>()=>{},getSnapshot:()=>({user:null})},profiles:{mine,getByHandle:vi.fn().mockResolvedValue(profilePage)}} as unknown as CommonsAccount}/>);
  expect(await screen.findByRole('heading',{name:'Example Maker'})).toBeTruthy();expect(screen.queryByRole('link',{name:'Edit profile'})).toBeNull();expect(mine).not.toHaveBeenCalled();
  expect(screen.getByRole('link',{name:'My profile'}).getAttribute('href')).toBe('#account');
});
it('links model creator credits to the creator handle path',async()=>{
  window.history.replaceState(null,'','/#models/workshop-hinge');
  render(<App loadCatalog={async()=>[exampleModel({creatorProfile:{id:profilePage.profile.id,handle:'example-maker',displayName:'Example Maker'}})]}/>);
  expect((await screen.findByRole('link',{name:'Example Maker'})).getAttribute('href')).toBe('/u/example-maker');
});

it('offers a real model-specific Open in PushForm action and explains unsupported original downloads', async () => {
  window.history.replaceState(null, '', '/#models/workshop-hinge');
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const model = exampleModel({ revision, files: [{ id, name: 'hinge.step', format: 'STEP', sizeBytes: 3, sha256: 'a'.repeat(64) }] });
  const view = render(<App loadCatalog={async () => [model]} editorUrl="http://localhost:5187" />);
  const action = await screen.findByRole('link', { name: 'Open in PushForm ↗' });
  const link = new URL(action.getAttribute('href')!); expect(link.searchParams.get('commonsModel')).toBe(model.id); expect(link.searchParams.get('commonsRevision')).toBe(revision); expect(link.searchParams.get('commonsAsset')).toBe(id); expect(action.getAttribute('target')).toBe('_blank');
  view.rerender(<App loadCatalog={async () => [exampleModel({ revision, files: [{ id, name: 'original.fcstd', format: 'FCSTD', sizeBytes: 3, sha256: 'a'.repeat(64) }] })]} />);
  await screen.findByText(/A supported model file or conversion is needed/); expect(screen.queryByRole('link', { name: 'Open in PushForm ↗' })).toBeNull();
});

it('refreshes discovery after a contributor publishes without requiring a full page reload',async()=>{
  const loader=vi.fn<CatalogLoader>().mockResolvedValueOnce([]).mockResolvedValue([exampleModel()]);
  render(<App loadCatalog={loader}/>);await screen.findByText('The library is ready for its first models.');
  fireEvent(window,new Event('commons:catalog-changed'));
  expect(await screen.findByRole('link',{name:'View Workshop hinge'})).toBeTruthy();expect(loader).toHaveBeenCalledTimes(2);
});
