/* Content-script DOM layer. No credentials, cookies, or private app APIs are read. */
(function(root){
  'use strict';
  const providers=[
    {runtime:'chatgpt-web',host:'chatgpt.com',path:/^(?:\/g\/g-[a-zA-Z0-9_-]{8,240}|\/g-[a-zA-Z0-9_-]{8,150})?\/c\/([a-zA-Z0-9_-]{8,150})(?:\/|$)/},
    {runtime:'codex-web',host:'chatgpt.com',path:/^\/codex\/(?:cloud\/)?tasks\/([a-zA-Z0-9_-]{8,150})(?:\/|$)/},
    {runtime:'deepseek-web',host:'chat.deepseek.com',path:/^\/a\/chat\/s\/([a-zA-Z0-9_-]{8,150})(?:\/|$)/}
  ];
  const MESSAGE_LIMIT=5,SCAN_LIMIT=32;
  const positions=new WeakMap();
  function identify(raw){
    try{
      const u=new URL(raw);
      if(u.protocol!=='https:')return null;
      for(const p of providers){
        if(u.hostname!==p.host)continue;
        const match=u.pathname.match(p.path);
        if(match)return {runtime:p.runtime,nativeId:match[1],url:u.origin+u.pathname};
      }
    }catch{}
    return null;
  }
  function visible(el){
    if(!el?.isConnected)return false;
    const r=el.getBoundingClientRect();
    const style=el.ownerDocument.defaultView?.getComputedStyle(el);
    return r.width>3 && r.height>3 && style?.display!=='none'&&style?.visibility!=='hidden';
  }
  function compact(text){return String(text||'').replace(/\u00a0/g,' ').replace(/\n{3,}/g,'\n\n').trim();}
  function checksum(str){
    let h=2166136261;
    for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619);}
    return (h>>>0).toString(36);
  }
  function candidates(doc,provider){
    const deepseek=provider.runtime==='deepseek-web';
    const chatgpt=provider.runtime==='chatgpt-web';
    // Never scan the whole document. Sidebar search results, dialogs and retained
    // SPA conversation DOM can contain messages from *other* conversations.
    const root=doc.querySelector('main')||doc.querySelector('[data-testid="conversation-panel"]')||doc.querySelector('#thread');
    if(!root)return [];
    const queries=deepseek?[
      '[data-message-author-role]','[data-role="user"]','[data-role="assistant"]',
      '[data-testid="message"]','.fbb737a4','.ds-markdown:not(.ds-markdown *)'
    ]:chatgpt?[
      '[data-message-author-role]','[data-role="user"]','[data-role="assistant"]',
      '[data-testid="conversation-turn"]','[data-testid="user-message"]',
      '[data-testid="assistant-message"]'
    ]:[
      '[data-message-author-role]','[data-role="user"]','[data-role="assistant"]',
      '[data-testid="message"]','[data-testid*="user-message"]','[data-testid*="assistant-message"]',
      '[class*="message-row"]'
    ];
    const results=[],seen=new Set(),nodes=root.querySelectorAll(queries.join(','));
    // Bound work before reading text or forcing layout. querySelectorAll's
    // union is in DOM order, so only the newest few candidates need inspection.
    for(let i=nodes.length-1,scanned=0;i>=0&&scanned<SCAN_LIMIT&&results.length<MESSAGE_LIMIT;i--,scanned++){
      const original=nodes[i];
      const el=chatgpt?(original.closest('[data-message-author-role]')||original.closest('[data-testid="conversation-turn"]')||original):original;
      if(seen.has(el))continue;
      if(el.closest('aside,nav,[role="navigation"],[role="dialog"],[aria-hidden="true"],[inert], [data-chatgpt-search-unit-key]'))continue;
      if(results.some(parent=>parent.contains(el)||el.contains(parent)))continue;
      if(!visible(el))continue;
      seen.add(el);positions.set(el,i);results.push(el);
    }
    return results.reverse();
  }
  function findRole(el){
    const role=(el.getAttribute('data-message-author-role')||el.getAttribute('data-role')||el.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role')||
      (el.querySelector('[data-testid="user-message"]')?'user':'')||
      (el.querySelector('[data-markdown-text-style="assistant-message"], [data-testid="assistant-message"]')?'assistant':'')||'').toLowerCase();
    if(role==='user')return 'user';
    if(role==='assistant'||role==='agent')return 'agent';
    const cls=typeof el.className==='string'?el.className:'';
    if(cls.includes('fbb737a4')||/user-message/i.test(cls))return 'user';
    if(cls.includes('ds-markdown')||/assistant-message/i.test(cls))return 'agent';
    const d=el.getAttribute('data-testid')||'';
    if(/user/i.test(d))return 'user';
    if(/assistant/i.test(d))return 'agent';
    return null;
  }
  function extract(doc,provider,{limit=MESSAGE_LIMIT}={}){
    if(!provider)return [];
    const results=[];
    const count=Number.isFinite(limit)?Math.max(1,Math.min(MESSAGE_LIMIT,limit)):MESSAGE_LIMIT;
    const found=candidates(doc,provider).slice(-count);
    // DOM order not selector query order: sort by document position.
    found.sort((a,b)=>a===b?0:(a.compareDocumentPosition(b)&2)?1:-1);
    let ordinal=0;
    for(const node of found){
      const role=findRole(node);
      if(!role)continue;
      const chatgpt=provider.runtime==='chatgpt-web';
      let scope=node;
      if(chatgpt){
        // Prefer answer text, not ChatGPT's toolbar, audio controls or hidden reasoning summaries.
        if(role==='agent')scope=node.querySelector('[data-markdown-text-style="assistant-message"],.markdown,.prose')||node;
        else scope=node.querySelector('.whitespace-pre-wrap,[data-testid="user-message"],.text-message')||node;
      }
      const body=compact(scope.innerText||scope.textContent);
      if(!body||body.length>20000)continue;
      const index=ordinal++;
      const stable=node.getAttribute('data-message-id')||node.getAttribute('data-chatgpt-search-message-ids')||'';
      const suffix=stable?checksum(stable):String(positions.get(node)??index);
      results.push({role,body,externalId:'dom-'+suffix+'-'+checksum(role+'\u0000'+body)});
    }
    return results;
  }
  function discover(doc,provider){
    if(!provider)return [];
    const result=new Map();
    for(const a of doc.querySelectorAll('aside a[href],nav a[href],[role="navigation"] a[href]')){
      const target=identify(a.href);
      if(!target||target.runtime!==provider.runtime||target.nativeId===provider.nativeId)continue;
      const title=compact(a.getAttribute('aria-label')||a.innerText||a.getAttribute('title')||'');
      if(!title||title.length>180)continue;
      result.set(target.nativeId,{...target,title});
      if(result.size>=100)break;
    }
    return [...result.values()];
  }
  function isGenerating(doc,provider){
    const selectors=provider?.runtime==='chatgpt-web'?[
      'button[data-testid="stop-button"]','button[aria-label="Stop generating" i]',
      'button[aria-label="停止生成"]','button[aria-label="停止响应"]'
    ]:[
      'button[aria-label="Stop generating" i]','button[aria-label*="停止生成"]',
      'button[data-testid*="stop"]'
    ];
    return selectors.some(selector=>[...doc.querySelectorAll(selector)].some(visible));
  }
  function composer(doc){
    const selectors=[
      '#prompt-textarea','[data-testid="prompt-textarea"]',
      '[contenteditable="true"][data-lexical-editor="true"]',
      '.ProseMirror[contenteditable="true"]',
      '[data-testid="composer"] textarea','[data-testid="composer"] [contenteditable="true"]',
      '[data-testid*="composer"] [contenteditable="true"]',
      'main textarea:not([readonly]):not([disabled])',
      'main [contenteditable="true"][role="textbox"]',
      'main [contenteditable="true"]',
      'textarea:not([readonly]):not([disabled])',
      '[contenteditable="true"][role="textbox"]','[contenteditable="true"]'
    ];
    for(const selector of selectors){
      for(const node of doc.querySelectorAll(selector)){
        if(visible(node)&&!node.closest('[aria-hidden="true"]')&&!node.closest('[inert]')&&
          !node.disabled&&node.getAttribute('aria-disabled')!=='true')return node;
      }
    }
    return null;
  }
  function buttonReady(el){
    if(!visible(el)||el.disabled||el.getAttribute('aria-disabled')==='true')return false;
    const description=[
      el.getAttribute('aria-label'),el.getAttribute('title'),el.getAttribute('data-testid'),
      el.id
    ].filter(Boolean).join(' ').toLowerCase();
    // Never confuse Stop, dictation, voice, file upload, or a menu with Send.
    if(/stop|cancel|abort|停止|中止|dictat|voice|microphone|record|语音|录音|麦克风|upload|attach/.test(description))return false;
    return true;
  }
  function nearestSendButton(node,provider){
    const form=node.closest('form');
    const scopes=[
      form,
      node.closest('[data-testid*="composer"]'),
      node.closest('[data-chatgpt-composer]'),
      node.closest('[role="form"]'),
      node.parentElement?.parentElement?.parentElement
    ].filter(Boolean);
    const patterns=provider.runtime==='chatgpt-web'?[
      'button[data-testid="send-button"]',
      '#composer-submit-button',
      '[role="button"][data-testid="send-button"]',
      'button[aria-label="Send prompt" i]',
      'button[aria-label="发送提示"]',
      'button[aria-label="发送"]',
      'button[type="submit"]'
    ]:[
      'button[data-testid="send-button"]',
      'button[type="submit"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="发送"]',
      'button[title*="Send" i]'
    ];
    for(const scope of [...new Set(scopes)]){
      for(const selector of patterns){
        const found=[...scope.querySelectorAll(selector)].filter(buttonReady);
        if(found.length===1)return found[0];
        if(found.length>1)throw new Error('Multiple possible Send buttons found; use original website');
      }
    }
    return null;
  }
  function fillEditor(el,text){
    const view=el.ownerDocument.defaultView;
    el.focus();
    if(el instanceof view.HTMLTextAreaElement || el instanceof view.HTMLInputElement){
      const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')?.set;
      if(!setter)throw new Error('Cannot interact with input field');
      setter.call(el,text);
      el.dispatchEvent(new view.Event('input',{bubbles:true}));
    }else if(el.isContentEditable){
      const selection=el.ownerDocument.getSelection();
      const range=el.ownerDocument.createRange();
      range.selectNodeContents(el);selection.removeAllRanges();selection.addRange(range);
      const inserted=el.ownerDocument.execCommand?.('insertText',false,text);
      if(!inserted)throw new Error('Website editor blocks safe text insertion; please reply in original page');
      // execCommand emits native input events understood by modern rich-text editors;
      // synthesizing a second input event can cause React to replace/reset the editor.
    }else throw new Error('Unsupported editor');
  }
  function attachmentPreview(doc){
    const node=composer(doc),scope=node?.closest('form')||node?.parentElement?.parentElement?.parentElement||doc;
    return [...scope.querySelectorAll('[data-testid*="attachment"],[data-testid*="preview"],[aria-label*="Remove attachment" i],[aria-label*="Remove image" i],[aria-label*="移除附件"],img[src^="blob:"]')]
      .some(el=>visible(el)&&!el.closest('nav,aside'));
  }
  async function attachImage(doc,image){
    if(!['image/png','image/jpeg','image/webp'].includes(image?.type)||!image?.data||image.data.length>4300000)
      throw new Error('只支持小于 3MB 的 PNG、JPEG、WebP 图片');
    let input=[...doc.querySelectorAll('input[type="file"]')].find(el=>!el.disabled&&
      (!el.accept||/image|png|jpeg|jpg|webp/i.test(el.accept)));
    if(!input){
      const buttons=[...doc.querySelectorAll('button[aria-label],button[data-testid]')].filter(el=>
        /attach|add photos|upload|上传|附件|添加图片/i.test((el.getAttribute('aria-label')||'')+' '+(el.getAttribute('data-testid')||'')));
      if(buttons.length===1)buttons[0].click();
      for(let i=0;i<12&&!input;i++){
        await new Promise(r=>setTimeout(r,120));
        input=[...doc.querySelectorAll('input[type="file"]')].find(el=>!el.disabled&&(!el.accept||/image|png|jpeg|jpg|webp/i.test(el.accept)));
      }
    }
    if(!input)throw new Error('网页未提供可用的图片上传输入框，请到原网页发送图片');
    const bytes=Uint8Array.from(atob(image.data),c=>c.charCodeAt(0));
    const file=new File([bytes],image.name||'attnwall-image.png',{type:image.type});
    const transfer=new DataTransfer();transfer.items.add(file);
    input.files=transfer.files;
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
    for(let i=0;i<42;i++){
      if(attachmentPreview(doc))return;
      await new Promise(r=>setTimeout(r,160));
    }
    throw new Error('网页未显示已添加图片的确认预览；请在原网站检查草稿，避免重复上传');
  }
  async function send(doc,provider,text,{image=null}={}){
    if(!provider||(typeof text!=='string')||(!text.trim()&&!image)||text.length>10000)throw new Error('Invalid conversation or reply');
    const route=identify(doc.location.href);
    if(route?.runtime!==provider.runtime||route.nativeId!==provider.nativeId)throw new Error('原网页会话已切换，尚未发送');
    if(isGenerating(doc,provider))throw new Error('原网页正在生成回复；请在结束后再发送');
    const want=compact(text);
    let editor=composer(doc);
    if(!editor)throw new Error('找不到原网页的可编辑输入框，请确认页面已加载');
    const content=el=>compact(el?.value??el?.innerText);
    const first=content(editor);
    // An earlier uncertain submission may have left the exact same draft visible.
    // Resuming that exact draft is safe; overwriting a different user draft is not.
    if(first&&first!==want)throw new Error('原网页已有其他草稿；先在原网页发送或清空它，不会覆盖你的内容');
    if(image)await attachImage(doc,image);
    editor=composer(doc)||editor;
    if(want&&!first){
      fillEditor(editor,text);
      // Allow the website's React render cycle to settle before finding Send.
      await new Promise(r=>setTimeout(r,150));
    }
    // Some React/Lexical apps replace the editor after accepting its input.
    // Repair the *unsent* draft only. No automatic retry happens after Send is clicked.
    let repairs=0;
    const routeMatches=()=>{
      const route=identify(doc.location.href);
      return route?.runtime===provider.runtime&&route.nativeId===provider.nativeId;
    };
    const ensureDraft=()=>{
      if(!routeMatches())throw new Error('原网页会话已切换，尚未发送');
      if(isGenerating(doc,provider))throw new Error('原网页正在生成回复；请在结束后再发送');
      const replacement=composer(doc);
      if(!replacement)throw new Error('原网页输入框暂不可用，请等待网页加载完成');
      editor=replacement;
      const current=content(editor);
      if(current===want)return true;
      if(current)throw new Error('原网页存在其他草稿，已停止发送以免覆盖');
      if(!want)return true;
      if(repairs>=3)throw new Error('原网页持续重建编辑器；未点击发送，请在原网页检查草稿');
      repairs++;
      fillEditor(editor,text);
      return false;
    };
    let ready=!want;
    for(let i=0;i<25;i++){
      ready=ensureDraft();
      if(ready)break;
      await new Promise(r=>setTimeout(r,130));
    }
    if(!ready)throw new Error('原网页未接受输入，尚未点击发送');
    let button=null;
    for(let i=0;i<30;i++){
      if(!ensureDraft()){
        await new Promise(r=>setTimeout(r,130));
        continue;
      }
      button=nearestSendButton(editor,provider);
      if(button)break;
      await new Promise(r=>setTimeout(r,130));
    }
    if(!button)throw new Error('已填入原网页草稿，但未找到唯一可点击的发送按钮；请到原网页手动发送');
    const echoed=()=>extract(doc,provider,{limit:Infinity}).filter(m=>m.role==='user'&&compact(m.body)===want).length;
    const before=want?echoed():0;
    button.click();
    for(let i=0;i<20;i++){
      await new Promise(r=>setTimeout(r,200));
      // Never treat detached nodes alone as proof that the website sent the reply.
      const current=composer(doc);
      if(!routeMatches())throw new Error('网页提交后会话发生切换；请检查原网页是否已发送，避免重复重试');
      if(want&&echoed()>before)return {sent:true};
      if(!image&&current===editor&&!content(current))return {sent:true};
      if(!current&&isGenerating(doc,provider))return {sent:true};
      if(image&&!attachmentPreview(doc)&&(!current||!content(current)))return {sent:true};
    }
    throw new Error('网页提交结果不确定；检查原网页是否已发送，避免重复重试');
  }  root.AttnWallBridgeDOM={identify,extract,discover,isGenerating,composer,send,checksum,messageNodes:candidates};
})(typeof globalThis!=='undefined'?globalThis:this);
