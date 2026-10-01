document.querySelectorAll(".copy").forEach(b=>b.addEventListener("click",()=>{
  const t=document.getElementById(b.dataset.copy).textContent;
  const done=()=>{b.textContent="Copied";setTimeout(()=>b.textContent="Copy",1600);};
  try{navigator.clipboard.writeText(t).then(done,()=>sel(b.dataset.copy));}catch{sel(b.dataset.copy);}
}));
function sel(id){const r=document.createRange();r.selectNodeContents(document.getElementById(id));const s=getSelection();s.removeAllRanges();s.addRange(r);}
