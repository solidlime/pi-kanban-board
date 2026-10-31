  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
  function md(s){
    var e = esc(s);
    e = e.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function(m, label, url){
      var low = url.toLowerCase();
      var ok = low.indexOf("http://") === 0 || low.indexOf("https://") === 0;
      return ok ? '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : m;
    });
    e = e.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    e = e.replace(/`([^`]+)`/g, '<code>$1</code>');
    var lines = e.split('\n'), res = [], list = [];
    var flush = function(){ if (list.length){ res.push('<ul>' + list.join('') + '</ul>'); list = []; } };
    for (var i = 0; i < lines.length; i++){
      var li = /^- (.*)$/.exec(lines[i]);
      if (li) list.push('<li>' + li[1] + '</li>');
      else { flush(); res.push(lines[i]); }
    }
    flush();
    return res.join('<br>');
  }
