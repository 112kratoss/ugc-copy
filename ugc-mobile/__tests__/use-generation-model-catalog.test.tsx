import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../contracts/model-catalog-transport-v1.json';
vi.mock('@react-native-async-storage/async-storage',()=>({default:{getItem:vi.fn(async()=>null),setItem:vi.fn(async()=>{})}}));
import { useGenerationModelCatalog } from '../lib/use-generation-model-catalog';

describe('useGenerationModelCatalog',()=>{
  it('checks revision on entry and picker opening, without background polling',async()=>{
    const response=(body:unknown)=>({body,etag:'"catalog"',notModified:false});
    const api={fetchModelCatalogCurrent:vi.fn(async()=>response(fixture.current)),fetchModelCatalogPage:vi.fn(async()=>response(fixture.page)),fetchModelCatalogDetails:vi.fn(async()=>response(fixture.details))};
    function Probe({open=false}:{open?:boolean}){const state=useGenerationModelCatalog(api,{kind:'image',selectedIds:['future-image-model'],pickerOpen:open});return React.createElement('state',{revision:state.catalog?.revision,models:state.catalog?.models.length});}
    let tree!:renderer.ReactTestRenderer;
    await renderer.act(async()=>{tree=renderer.create(<Probe/>);});
    expect(api.fetchModelCatalogCurrent).toHaveBeenCalledTimes(1);
    expect(tree.root.findByType('state' as React.ElementType).props.models).toBe(1);
    await renderer.act(async()=>{tree.update(<Probe open/>);});
    expect(api.fetchModelCatalogCurrent).toHaveBeenCalledTimes(2);
    expect(api.fetchModelCatalogDetails).toHaveBeenCalledTimes(1);
    await renderer.act(async()=>{tree.unmount();});
  });

  it('loads every tool\'s default with the open tool\'s, so an untouched draft of another tool can take its default', async()=>{
    // The Create tab opens on Image; a video draft that waited for its default until Video was
    // opened showed its bundled stand-in first.
    const current={...fixture.current,defaults:{image:'future-image-model',video:'future-video-model',motion:'future-motion-model'}};
    const response=(body:unknown)=>({body,etag:'"catalog"',notModified:false});
    const api={fetchModelCatalogCurrent:vi.fn(async()=>response(current)),fetchModelCatalogPage:vi.fn(async()=>response(fixture.page)),fetchModelCatalogDetails:vi.fn(async(_query:string)=>{void _query;return response(fixture.details);})};
    function Probe(){useGenerationModelCatalog(api,{kind:'image',selectedIds:['future-image-model']});return null;}
    let tree!:renderer.ReactTestRenderer;
    await renderer.act(async()=>{tree=renderer.create(<Probe/>);});
    const asked=api.fetchModelCatalogDetails.mock.calls.flatMap(([query])=>new URLSearchParams(String(query)).get('ids')?.split(',')??[]);
    expect(asked).toEqual(expect.arrayContaining(['future-image-model','future-video-model','future-motion-model']));
    await renderer.act(async()=>{tree.unmount();});
  });
});
