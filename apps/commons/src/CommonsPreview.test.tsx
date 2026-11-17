// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommonsModelPreview, CommonsThumbnail } from './CommonsPreview';
import { catalogModelSchema } from '@pushform/cloud';
import { exampleModel } from './catalog.fixture';
const id='11111111-1111-4111-8111-111111111111';
const file={id,name:'test.stl',format:'STL',sizeBytes:100,sha256:'a'.repeat(64)};
const model=catalogModelSchema.parse(exampleModel({revision:'22222222-2222-4222-8222-222222222222',files:[file]}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('Commons previews',()=>{
  it('previews the native model instead of an alphabetically earlier notice archive or FreeCAD source',async()=>{
    const fetcher=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({status:'ready',error:null}),{headers:{'Content-Type':'application/json'}}));
    vi.stubGlobal('fetch',fetcher);
    const files=['a-notices.zip','b-source.FCStd','c-model.step','d-model.pf'].map((name,index)=>({...file,name,id:`11111111-1111-4111-8111-11111111111${index}`}));
    render(<CommonsThumbnail model={{...model,files}} filesUrl="http://localhost:8792"/>);
    expect((await screen.findByRole('img')).getAttribute('src')).toBe(`http://localhost:8792/thumbnails/${files[3]!.id}`);
    // A rendered thumbnail loads directly, without first asking for its render status.
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('checks a failed thumbnail once for every card showing it, then shows it when its render is ready',async()=>{
    const shared={...file,id:'33333333-3333-4333-8333-333333333333'};
    const fetcher=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({status:'ready',error:null}),{headers:{'Content-Type':'application/json'}}));
    vi.stubGlobal('fetch',fetcher);
    const shown={...model,files:[shared]};
    render(<><CommonsThumbnail model={shown} filesUrl="http://localhost:8792"/><CommonsThumbnail model={shown} filesUrl="http://localhost:8792"/></>);
    for(const image of screen.getAllByRole('img'))fireEvent.error(image);
    await waitFor(()=>expect(screen.getAllByRole('img')).toHaveLength(2));
    for(const image of screen.getAllByRole('img'))expect(image.getAttribute('src')).toBe(`http://localhost:8792/thumbnails/${shared.id}`);
    expect(fetcher.mock.calls.filter(call=>String(call[0]).endsWith(`/preview-status/${shared.id}`))).toHaveLength(1);
  });
  it('prefers an uploaded image and falls back to geometry when images fail',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>new Response(JSON.stringify({status:'ready',error:null}),{headers:{'Content-Type':'application/json'}})));
    render(<CommonsThumbnail model={{...model,previewImage:{...file,name:'photo.png',format:'PNG'},imageUrl:'https://example.com/photo.jpg'}} filesUrl="http://localhost:8792"/>);
    const image=screen.getByRole('img');expect(image.getAttribute('src')).toBe(`http://localhost:8792/images/${id}`);
    fireEvent.error(image);expect(image.getAttribute('src')).toBe('https://example.com/photo.jpg');
    fireEvent.error(image);const generated=await screen.findByRole('img');expect(generated.getAttribute('src')).toBe(`http://localhost:8792/thumbnails/${id}`);
    for(let i=0;i<3;i++){fireEvent.error(await screen.findByRole('img'));}
    await waitFor(()=>expect(screen.getByText('Preview unavailable')).toBeTruthy());
  });
  it('loads a public derivative only on request and supports orbit, zoom and reset',async()=>{
    const fetcher=vi.fn().mockImplementation(async(url:string)=>String(url).includes('/preview-status/')?new Response(JSON.stringify({status:'ready',error:null}),{headers:{'Content-Type':'application/json'}}):new Response(JSON.stringify({modelId:model.id,revision:model.revision,mesh:{version:1,positions:[-.5,-.5,-.5,.5,-.5,-.5,-.5,.5,.5]}}),{headers:{'Content-Type':'application/json'}}));vi.stubGlobal('fetch',fetcher);
    const {container}=render(<CommonsModelPreview model={model} filesUrl="http://localhost:8792"/>);expect(fetcher.mock.calls.some(call=>String(call[0]).includes('/previews/'))).toBe(false);
    fireEvent.click(screen.getByText('Explore in 3D'));await waitFor(()=>expect(container.querySelectorAll('canvas.preview-viewer')).toHaveLength(1));
    const points=()=>container.querySelector('canvas.preview-viewer')?.getAttribute('data-view');const initial=points();
    fireEvent.click(screen.getByLabelText('Rotate right'));expect(points()).not.toBe(initial);
    fireEvent.click(screen.getByText('Reset view'));expect(points()).toBe(initial);
    fireEvent.click(screen.getByLabelText('Zoom in'));expect(points()).not.toBe(initial);
    fireEvent.keyDown(screen.getByRole('img'),{key:'0'});expect(points()).toBe(initial);
    expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({credentials:'omit',redirect:'error'});
  });
  it('offers a thumbnail and useful error when the server cannot render',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async(url:string)=>String(url).includes('/preview-status/')?new Response(JSON.stringify({status:'ready',error:null}),{headers:{'Content-Type':'application/json'}}):new Response('',{status:422})));
    render(<CommonsModelPreview model={model} filesUrl="http://localhost:8792"/>);fireEvent.click(screen.getByText('Explore in 3D'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','This model cannot be previewed yet. Try Open in PushForm.');expect(screen.getByText('Retry preview')).toBeTruthy();
  });
});
