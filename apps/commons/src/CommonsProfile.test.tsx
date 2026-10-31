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
afterEach(cleanup);
it('shows public creator information and established published model links without fabricated social activity',async()=>{
  const profiles={get:vi.fn().mockResolvedValue({profile:fields,models:[exampleModel()]})} as unknown as CommonsProfiles;
  render(<CommonsProfilePageView id={id} profiles={profiles}/>);expect(await screen.findByRole('heading',{name:'Example Maker'})).toBeTruthy();expect(screen.getByRole('link',{name:'Workshop hinge'}).getAttribute('href')).toBe('#models/workshop-hinge');expect(screen.getByRole('link',{name:'Portfolio ↗'}).getAttribute('rel')).toContain('noreferrer');expect(screen.queryByText(/Level 1/)).toBeNull();
});
it('distinguishes an unavailable profile from loading failure and offers retry',async()=>{
  const get=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null);render(<CommonsProfilePageView id={id} profiles={{get} as unknown as CommonsProfiles}/>);
  expect(await screen.findByRole('alert')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Try again'}));expect(await screen.findByText('This profile isn’t available.')).toBeTruthy();
});
it('requires explicit public opt-in and validated fields before creating a public profile',async()=>{
  const save=vi.fn().mockResolvedValue(profile);render(<CommonsProfileEditor profiles={{mine:vi.fn().mockResolvedValue(null),save} as unknown as CommonsProfiles}/>);
  const button=await screen.findByRole('button',{name:'Publish public profile'});expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Public handle'),{target:{value:'example-maker'}});fireEvent.change(screen.getByLabelText('Display name'),{target:{value:'Example Maker'}});
  fireEvent.click(screen.getByRole('checkbox',{name:/these profile fields will be public/}));fireEvent.click(button);
  await waitFor(()=>expect(save).toHaveBeenCalledWith({...fields,bio:'',links:[]},null,true));expect(await screen.findByRole('link',{name:'View your public profile'})).toBeTruthy();expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
});
it('keeps handles immutable and lets owners hide their public page without removing attribution',async()=>{
  const hide=vi.fn().mockResolvedValue({...profile,active:false,version:2});render(<CommonsProfileEditor profiles={{mine:vi.fn().mockResolvedValue(profile),hide} as unknown as CommonsProfiles}/>);
  await screen.findByRole('button',{name:'Hide public profile'});expect((screen.getByLabelText('Public handle') as HTMLInputElement).disabled).toBe(true);fireEvent.click(screen.getByRole('button',{name:'Hide public profile'}));
  await waitFor(()=>expect(hide).toHaveBeenCalledWith(1));expect(await screen.findByText(/Original model attribution remains available/)).toBeTruthy();expect(screen.queryByRole('link',{name:'View your public profile'})).toBeNull();
});
it('links original author credit only when an account association is established',()=>{
  const view=render(<CreatorCredit model={{creator:'Original Author',creatorProfile:null}}/>);expect(screen.queryByRole('link')).toBeNull();view.rerender(<CreatorCredit model={{creator:'Original Author',creatorProfile:{id}}}/>);expect(screen.getByRole('link',{name:'Original Author'}).getAttribute('href')).toBe('#people/'+id);
});
