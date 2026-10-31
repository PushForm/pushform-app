// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import { commonsFileUrl, uploadCommonsFile, removeCommonsFile, reviewCommonsFile, downloadCommonsFile, CommonsTermsRequiredError } from './CommonsFiles';
const revision='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';const id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const signal=()=>new AbortController().signal;
const file=Object.assign(new Blob(['abc']),{name:'part.step'});
const reservation={id,revision_id:revision,filename:file.name,format:'step',size_bytes:3,sha256:'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',status:'pending',created_at:'2026-10-31T00:00:00Z',verified_at:null};
it('allows only configured service origins and valid file identifiers',()=>{
  expect(commonsFileUrl('https://files.example','downloads',id)).toBe('https://files.example/downloads/'+id);
  for(const url of ['http://files.example','https://user:secret@files.example','https://files.example/path','https://files.example?token=secret','javascript:alert(1)'])expect(commonsFileUrl(url,'uploads')).toBeNull();
  expect(commonsFileUrl('http://localhost:8788','uploads',id)).toBe('http://localhost:8788/uploads/'+id);
  expect(commonsFileUrl('https://files.example','downloads','../escape')).toBeNull();
});
it('hashes the selected bytes and uses bearer-only reservations followed by a verified upload',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(reservation)).mockResolvedValueOnce(Response.json({id,status:'ready'}));
  expect(await uploadCommonsFile('https://files.example','session',revision,file,signal(),fetcher)).toMatchObject({id,status:'ready'});
  const [url,init]=fetcher.mock.calls[0]!;expect(url).toBe('https://files.example/uploads');expect(JSON.parse(init!.body as string)).toMatchObject({sha256:reservation.sha256,sizeBytes:3,revision});
  for(const [address,options] of fetcher.mock.calls){expect(address).not.toContain('session');expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer session');expect(options).toMatchObject({credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});}
  expect(fetcher.mock.calls[1]![1]!.body).toBe(file);
});
it('refuses mismatched reservations, unverified receipts and unsafe local files',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({...reservation,sha256:'0'.repeat(64)}));
  await expect(uploadCommonsFile('https://files.example','session',revision,file,signal(),fetcher)).rejects.toThrow('does not match');expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockReset().mockResolvedValueOnce(Response.json(reservation)).mockResolvedValueOnce(Response.json({id,status:'pending'}));
  await expect(uploadCommonsFile('https://files.example','session',revision,file,signal(),fetcher)).rejects.toThrow('not verified');
  fetcher.mockClear();for(const name of ['../part.step','.hidden.step','script.js'])await expect(uploadCommonsFile('https://files.example','session',revision,Object.assign(new Blob(['abc']),{name}),signal(),fetcher)).rejects.toThrow('supported model');
  expect(fetcher).not.toHaveBeenCalled();
});
it('supports idempotent retries, aborts before networking, and sanitizes service errors',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({...reservation,status:'ready'}));
  await uploadCommonsFile('https://files.example','session',revision,file,signal(),fetcher);expect(fetcher).toHaveBeenCalledTimes(1);
  const controller=new AbortController();controller.abort();fetcher.mockClear();await expect(uploadCommonsFile('https://files.example','session',revision,file,controller.signal,fetcher)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(new Response('private backend detail',{status:409}));await expect(removeCommonsFile('https://files.example','session',id,signal(),fetcher)).rejects.toThrow('Refresh');
  fetcher.mockResolvedValueOnce(new Response('ZIP'));expect(await (await reviewCommonsFile('https://files.example','session',id,signal(),fetcher)).text()).toBe('ZIP');
});

it('downloads only with bearer credentials and distinguishes incomplete account setup',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('ZIP',{headers:{'Content-Type':'application/zip'}}));
  expect(await (await downloadCommonsFile('https://files.example','session',id,signal(),fetcher)).text()).toBe('ZIP');
  expect(fetcher.mock.calls[0]![0]).toBe('https://files.example/downloads/'+id);
  expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get('Authorization')).toBe('Bearer session');
  expect(fetcher.mock.calls[0]![1]).toMatchObject({credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
  fetcher.mockResolvedValueOnce(Response.json({code:'commons_terms_required'},{status:403}));
  await expect(downloadCommonsFile('https://files.example','session',id,signal(),fetcher)).rejects.toBeInstanceOf(CommonsTermsRequiredError);
  fetcher.mockResolvedValueOnce(new Response('<html>unexpected</html>',{headers:{'Content-Type':'text/html'}}));
  await expect(downloadCommonsFile('https://files.example','session',id,signal(),fetcher)).rejects.toThrow('did not return a model package');
});
