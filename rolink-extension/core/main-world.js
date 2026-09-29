// world:MAIN fetch tap to capture truncated renders (ChatGPT long lines)
(function(){
  const origFetch=window.fetch;
  window.fetch=async function(...args){
    const res=await origFetch.apply(this,args);
    try{
      const clone=res.clone();
      const url=String(args[0]);
      if(url.includes("backend-api")||url.includes("api/chat")){
        clone.text().then(t=> window.postMessage({source:"rolink-main", type:"sse", payload:t.slice(0,4000)}, "*"));
      }
    }catch{}
    return res;
  };
})();
