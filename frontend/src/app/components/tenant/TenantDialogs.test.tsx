import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TenantConfirmDialog, TenantFormDialog } from './TenantDialogs';
import { TenantPresentationProvider } from './tenantPresentation';
const observed=vi.hoisted(()=>({props:{} as Record<string,unknown>}));
vi.mock('../landlord/landlordUi',()=>({
 ConfirmDialog:(props:Record<string,unknown>)=>{observed.props=props;return <div>{props.title as string}</div>;},
 FormDialog:(props:Record<string,unknown>)=>{observed.props=props;return <div>{props.title as string}</div>;},
}));
beforeEach(()=>{observed.props={};});
describe('tenant confirmation uses only the reviewed shared presentation seam',()=>{
 it('keeps a tenant-only handoff fallback out of the inactive shared form dialog',()=>{
  const props={open:false,title:'Original visit question',description:'Original authority copy',onOpenChange:vi.fn(),children:'Original form'};
  const fallback=vi.fn();
  renderToStaticMarkup(<TenantFormDialog {...props} returnFocusFallback={fallback}/>);
  expect(observed.props).toEqual(props);expect(fallback).not.toHaveBeenCalled();
  expect(props.onOpenChange).not.toHaveBeenCalled();
 });
 it('passes the original confirmation props untouched outside tenant activation',()=>{
  const props={open:true,title:'Original delete question',description:'Original authority copy',onConfirm:vi.fn(),onOpenChange:vi.fn()};
  renderToStaticMarkup(<TenantConfirmDialog {...props}/>);
  expect(observed.props).toEqual(props);
  expect(props.onConfirm).not.toHaveBeenCalled();expect(props.onOpenChange).not.toHaveBeenCalled();
 });
 it('supplies only class and named focus callbacks while preserving shared busy/action ownership',()=>{
  const props={open:true,title:'Original delete question',description:'Original authority copy',onConfirm:vi.fn(),onOpenChange:vi.fn()};
  renderToStaticMarkup(<TenantPresentationProvider active><TenantConfirmDialog {...props}/></TenantPresentationProvider>);
  for(const key of Object.keys(props))expect(observed.props[key]).toBe(props[key as keyof typeof props]);
  expect(Object.keys(observed.props).sort()).toEqual([...Object.keys(props),'className','onOpenAutoFocus','onCloseAutoFocus','onFocusCapture'].sort());
  for(const key of ['onOpenAutoFocus','onCloseAutoFocus','onFocusCapture'])expect(observed.props[key]).toBeTypeOf('function');
  expect(observed.props.className).toContain('lichen-d5');expect(observed.props.className).not.toContain('lichen-d3');
  expect(props.onConfirm).not.toHaveBeenCalled();
 });
});
