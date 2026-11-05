// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommonsProfileEditor, CommonsProfilePageView, CreatorCredit } from './CommonsProfile';
import type { CommonsProfiles } from '@pushform/cloud';
import { exampleModel } from './catalog.fixture';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const fields={handle:'example-maker',displayName:'Example Maker',bio:'A maker bio',avatarUrl:null,links:[{label:'Portfolio',url:'https://example.com'}]};
const profile={...fields,id,active:true,version:1};
afterEach(()=>{cleanup();window.history.replaceState(null,'','/');});
it('shows public creator information and established published model links without fabricated social activity',async()=>{
  const getByHandle=vi.fn().mockResolvedValue({profile:{...fields,id},models:[exampleModel()]});const profiles={getByHandle} as unknown as CommonsProfiles;
  render(<CommonsProfilePageView lookup={{handle:'example-maker'}} profiles={profiles}/>);expect(getByHandle).toHaveBeenCalledWith('example-maker',expect.anything());expect(await screen.findByRole('heading',{name:'Example Maker'})).toBeTruthy();expect(screen.getByRole('link',{name:'Workshop hinge'}).getAttribute('href')).toBe('/models/workshop-hinge');expect(screen.getByRole('link',{name:'Portfolio ↗'}).getAttribute('rel')).toContain('noreferrer');expect(screen.queryByText(/Level 1/)).toBeNull();
});
it('distinguishes an unavailable profile from loading failure and offers retry',async()=>{
  const getByHandle=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null);render(<CommonsProfilePageView lookup={{handle:'example-maker'}} profiles={{getByHandle} as unknown as CommonsProfiles}/>);
  expect(await screen.findByRole('alert')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Try again'}));expect(await screen.findByText('This profile isn’t available.')).toBeTruthy();
});
it('moves an older account-ID profile link to the handle address without loading it twice',async()=>{
  window.history.replaceState(null,'','/#people/'+id);const get=vi.fn().mockResolvedValue({profile:{...fields,id},models:[]});const getByHandle=vi.fn();
  const view=render(<CommonsProfilePageView lookup={{id}} profiles={{get,getByHandle} as unknown as CommonsProfiles}/>);
  expect(await screen.findByRole('heading',{name:'Example Maker'})).toBeTruthy();expect(get).toHaveBeenCalledWith(id,expect.anything());
  expect(window.location.pathname).toBe('/u/example-maker');expect(window.location.hash).toBe('');
  view.rerender(<CommonsProfilePageView lookup={{handle:'example-maker'}} profiles={{get,getByHandle} as unknown as CommonsProfiles}/>);expect(screen.getByRole('heading',{name:'Example Maker'})).toBeTruthy();expect(getByHandle).not.toHaveBeenCalled();
});
it('publishes validated fields without a separate confirmation and opens the new public profile',async()=>{
  const save=vi.fn().mockResolvedValue(profile);window.history.replaceState(null,'','/#account');render(<CommonsProfileEditor profiles={{mine:vi.fn().mockResolvedValue(null),save} as unknown as CommonsProfiles}/>);
  const button=await screen.findByRole('button',{name:'Publish public profile'});expect(screen.queryByRole('checkbox')).toBeNull();
  fireEvent.submit(button.closest('form')!);expect(await screen.findByRole('alert')).toBeTruthy();expect(save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Public handle'),{target:{value:'example-maker'}});fireEvent.change(screen.getByLabelText('Display name'),{target:{value:'Example Maker'}});
  expect((button as HTMLButtonElement).disabled).toBe(false);fireEvent.click(button);
  await waitFor(()=>expect(save).toHaveBeenCalledWith({...fields,bio:'',links:[]},null,true));
  await waitFor(()=>expect(window.location.pathname).toBe('/u/example-maker'));expect(window.location.hash).toBe('');
});
it('keeps handles immutable, links the saved profile by handle and offers no hide or reload controls',async()=>{
  const save=vi.fn().mockResolvedValue({...profile,displayName:'Renamed Maker',version:2});render(<CommonsProfileEditor profiles={{mine:vi.fn().mockResolvedValue(profile),save} as unknown as CommonsProfiles}/>);
  const button=await screen.findByRole('button',{name:'Save public profile'});expect((screen.getByLabelText('Public handle') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByRole('link',{name:'View your public profile'}).getAttribute('href')).toBe('/u/example-maker');
  expect(screen.queryByRole('button',{name:/Hide public profile/})).toBeNull();expect(screen.queryByRole('button',{name:/Reload profile/})).toBeNull();
  fireEvent.change(screen.getByLabelText('Display name'),{target:{value:'Renamed Maker'}});fireEvent.click(button);
  await waitFor(()=>expect(save).toHaveBeenCalledWith({...fields,displayName:'Renamed Maker'},1,true));await waitFor(()=>expect(window.location.pathname).toBe('/u/example-maker'));
});
it('links original author credit only when an account association is established',()=>{
  const view=render(<CreatorCredit model={{creator:'Original Author',creatorProfile:null}}/>);expect(screen.queryByRole('link')).toBeNull();view.rerender(<CreatorCredit model={{creator:'Original Author',creatorProfile:{handle:'original-author'}}}/>);const link=screen.getByRole('link',{name:'Original Author'});expect(link.getAttribute('href')).toBe('/u/original-author');
  fireEvent.click(link);expect(window.location.pathname).toBe('/u/original-author');
});

it('places collections before published models and keeps owner model management private',async()=>{
  const profiles={getByHandle:vi.fn().mockResolvedValue({profile:{...fields,id},models:[exampleModel()]})} as unknown as CommonsProfiles;
  const renderCollections=vi.fn((handle:string,owner:boolean,profileId:string)=><section aria-label="Test collections">{handle}:{String(owner)}:{profileId}</section>);
  const renderOwnModels=vi.fn(()=><section aria-label="Owner models">Private draft controls</section>);
  const view=render(<CommonsProfilePageView lookup={{handle:fields.handle}} profiles={profiles} ownProfileId={id} renderCollections={renderCollections} renderOwnModels={renderOwnModels}/>);
  const collections=await screen.findByRole('region',{name:'Test collections'});
  expect(renderCollections).toHaveBeenLastCalledWith(fields.handle,true,id);
  expect(collections.compareDocumentPosition(screen.getByRole('region',{name:'Owner models'}))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole('heading',{name:'Published models'})).toBeNull();
  view.rerender(<CommonsProfilePageView lookup={{handle:fields.handle}} profiles={profiles} ownProfileId="another-account" renderCollections={renderCollections} renderOwnModels={renderOwnModels}/>);
  expect(renderCollections).toHaveBeenLastCalledWith(fields.handle,false,id);
  expect(screen.queryByRole('region',{name:'Owner models'})).toBeNull();
  expect(collections.compareDocumentPosition(screen.getByRole('heading',{name:'Published models'}))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
