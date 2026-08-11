// Guards the failure mode that has now bitten three times: an edit deletes a
// definition but leaves its call sites. That still parses and still evaluates,
// because the reference only runs later inside a handler.
const fs=require('fs');
const h=fs.readFileSync(process.argv[2]||'index.html','utf8');
let js=h.slice(h.indexOf('<script>')+8,h.lastIndexOf('</script>'));
const declared=new Set();
for(const re of [/\bfunction\s+([A-Za-z_$][\w$]*)/g,/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g]){
  for(const m of js.matchAll(re)) declared.add(m[1]);
}
// strip comments, template literals, and quoted strings so prose is not scanned
js=js.replace(/\/\*[\s\S]*?\*\//g,' ')
     .replace(/(^|[^:])\/\/[^\n]*/g,'$1 ')
     .replace(/`(?:\\.|[^`\\])*`/g,'``')
     .replace(/'(?:\\.|[^'\\\n])*'/g,"''")
     .replace(/"(?:\\.|[^"\\\n])*"/g,'""');
const builtins=new Set(['Math','JSON','Date','Object','Array','String','Number','Boolean','Promise','Map','Set','RegExp','Error','Uint8Array','Float32Array','DataView','ArrayBuffer','TextEncoder','TextDecoder','MediaRecorder','MediaSource','AudioContext','SpeechSynthesisUtterance','Audio','Image','Blob','URL','FormData','FileReader','AbortController','Intl','Symbol','WeakMap','Infinity','NaN']);
// Require a lowercase-started member after the dot AND a call or assignment,
// which prose like "Done." and "Applied." never satisfies.
const used=new Set([...js.matchAll(/\b([A-Z][A-Za-z0-9_$]*)\.([a-z][\w$]*)\s*(?=[(=[.])/g)].map(m=>m[1]));
// Single capitals come from regex/template artefacts in the stripper, not real code.
const missing=[...used].filter(id=>id.length>1&&!declared.has(id)&&!builtins.has(id));
if(missing.length){ console.log('UNDEFINED references:'); missing.forEach(x=>console.log('   '+x)); process.exit(1); }
console.log('reference check: every object referenced is defined ('+declared.size+' declarations scanned)');
