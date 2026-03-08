  // ── VERSION
  fetch('/api/version').then(r => r.json()).then(d => {
    const el = document.getElementById('app-version');
    if (el && d.version) el.textContent = `v${d.version}`;
  }).catch(() => {});

  // ── STATE
  let devices = [], selRow = null, activeUserCard = null;
  let sortCol = 'deviceName', sortDir = 1; // 1=asc, -1=desc
  let autopatchMembers = [];

  // ── UTILS
  const $ = id => document.getElementById(id);

  function bytes(b) {
    if (!b) return '—';
    const gb = b / 1073741824;
    return gb >= 1 ? `${gb.toFixed(1)} Go` : `${(b / 1048576).toFixed(0)} Mo`;
  }

  function ago(d) {
    if (!d) return '—';
    const days = Math.floor((Date.now() - new Date(d)) / 86400000);
    if (days === 0) return "Aujourd'hui";
    if (days === 1) return 'Hier';
    if (days < 7)  return `Il y a ${days} j`;
    if (days < 30) return `Il y a ${Math.floor(days/7)} sem`;
    return `Il y a ${Math.floor(days/30)} mois`;
  }

  function stale(d) {
    return !d || Date.now() - new Date(d) > 7*86400000;
  }

  function osIcon(os) {
    if (!os) return '□';
    const s = os.toLowerCase();
    if (s.includes('windows')) return '⊞';
    if (s.includes('mac'))     return '◈';
    if (s.includes('linux'))   return '◉';
    return '□';
  }

  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('fr-FR', {day:'2-digit',month:'2-digit',year:'numeric'});
  }

  function fmtDateTime(d) {
    if (!d) return '—';
    return new Date(d).toLocaleString('fr-FR', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
  }

  function fmtTime(d) {
    if (!d) return '—';
    return new Date(d).toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
  }

  function logonStats(logons) {
    if (!logons.length) return { firstToday: null, lastActivity: null };
    const today = new Date().toDateString();
    const todayEntries = logons.filter(l => new Date(l.lastLogOnDateTime).toDateString() === today);
    const firstToday = todayEntries.length
      ? todayEntries.reduce((a, b) => new Date(a.lastLogOnDateTime) < new Date(b.lastLogOnDateTime) ? a : b)
      : null;
    const lastActivity = logons.reduce((a, b) =>
      new Date(a.lastLogOnDateTime) > new Date(b.lastLogOnDateTime) ? a : b
    );
    return { firstToday, lastActivity };
  }

  function initials(name) {
    if (!name) return '?';
    return name.trim().split(/\s+/).map(p=>p[0]).join('').toUpperCase().slice(0,2);
  }

  // ── FETCH
  async function api(path, opts = {}) {
    const r = await fetch(path, opts);
    if (r.status === 401) { window.location.href = '/login.html'; return; }
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); detail = j.detail ? ` — ${JSON.stringify(j.detail)}` : (j.error ? ` — ${j.error}` : ''); } catch {}
      throw new Error(`HTTP ${r.status}${detail}`);
    }
    return r.json();
  }

  // ── USER SESSION
  fetch('/auth/me').then(r => r.ok ? r.json() : null).then(u => {
    if (!u) return;
    const status = document.querySelector('.status');
    const userEl = document.createElement('div');
    userEl.className = 'session-user';
    userEl.innerHTML = `<span class="session-name">${u.name || u.upn}</span><a href="/auth/logout" class="session-logout">Déconnexion</a>`;
    status.before(userEl);
  });

  // ── STATS
  function setStats(list) {
    const win   = list.filter(d => d.operatingSystem?.toLowerCase().includes('windows')).length;
    const syncd = list.filter(d => !stale(d.lastSyncDateTime)).length;
    $('s-total').textContent = list.length;
    $('s-win').textContent   = win;
    $('s-ok').textContent    = syncd;
    $('s-old').textContent   = list.length - syncd;
  }

  // ── DEVICES TABLE
  function sortedList(list) {
    return [...list].sort((a, b) => {
      let va = a[sortCol] ?? '', vb = b[sortCol] ?? '';
      if (sortCol === 'lastSyncDateTime') {
        va = va ? new Date(va).getTime() : 0;
        vb = vb ? new Date(vb).getTime() : 0;
        return (va - vb) * sortDir;
      }
      return va.toString().localeCompare(vb.toString(), 'fr', { sensitivity: 'base' }) * sortDir;
    });
  }

  function renderDevices(list) {
    const tb = $('dev-body');
    tb.innerHTML = '';
    sortedList(list).forEach((d, i) => {
      const tr = document.createElement('tr');
      tr.dataset.id = d.id;
      tr.style.animationDelay = `${i * 0.025}s`;
      const old = stale(d.lastSyncDateTime);
      tr.innerHTML = `
        <td class="dev-name">${d.deviceName || '—'}</td>
        <td>
          <span class="os-row">
            <span>${osIcon(d.operatingSystem)}</span>
            <span>${d.operatingSystem || '—'}</span>
            ${d.osVersion ? `<span class="os-ver">${d.osVersion}</span>` : ''}
          </span>
        </td>
        <td class="muted">${d.manufacturer || '—'} / ${d.model || '—'}</td>
        <td class="sync ${old?'old':'ok'}">${ago(d.lastSyncDateTime)}</td>
      `;
      tr.addEventListener('click', () => openPanel(d, tr));
      tb.appendChild(tr);
    });
  }

  function filterDev(q) {
    if (!q) return devices;
    const s = q.toLowerCase();
    return devices.filter(d =>
      [d.deviceName, d.operatingSystem, d.manufacturer, d.model, d.osVersion]
        .some(v => v?.toLowerCase().includes(s))
    );
  }

  async function loadDevices() {
    try {
      devices = await api('/api/devices');
      $('dev-loading').style.display = 'none';
      $('dev-table').style.display = '';
      setStats(devices);
      renderDevices(devices);
      $('badge-dev').textContent = `${devices.length} appareil${devices.length!==1?'s':''}`;
      $('ts').textContent = new Date().toLocaleTimeString('fr-FR');
    } catch(e) {
      $('dev-loading').innerHTML = `<span style="color:var(--red)">Erreur : ${e.message}</span>`;
    }
  }

  // ── PANEL
  async function openPanel(d, row) {
    if (selRow) selRow.classList.remove('sel');
    selRow = row; row.classList.add('sel');

    $('p-name').textContent = d.deviceName || '—';

    const fields = [
      ['OS',            `${d.operatingSystem||'—'} ${d.osVersion||''}`],
      ['Fabricant',     d.manufacturer || '—'],
      ['Modèle',        d.model || '—'],
      ['N° série',      d.serialNumber || '—'],
      ['Enrollé le',    fmtDate(d.enrolledDateTime)],
      ['Dernière sync', fmtDateTime(d.lastSyncDateTime)],
    ];

    $('p-fields').innerHTML = fields.map(([l,v]) => `
      <div class="field">
        <div class="fl">${l}</div>
        <div class="fv">${v}</div>
      </div>
    `).join('');

    // Affichage immédiat avec les données du device
    if (d.userDisplayName || d.userPrincipalName) {
      const name = d.userDisplayName || d.userPrincipalName;
      $('p-user').innerHTML = `
        <div class="user-card" id="p-user-card">
          <div class="avatar">${initials(name)}</div>
          <div style="min-width:0">
            <div class="u-name">${name}</div>
            <div class="u-upn">${d.userPrincipalName || d.emailAddress || ''}</div>
            <div class="u-upn" id="p-first-login" style="margin-top:3px;color:var(--text-muted)"><span class="blink">…</span></div>
            <div class="u-upn" id="p-last-activity" style="margin-top:1px;color:var(--text-muted)"></div>
          </div>
        </div>`;

      // Fetch sessions poste (usersLoggedOn via beta API)
      api(`/api/devices/${d.id}/logons`)
        .then(logons => {
          const elFirst = $('p-first-login');
          const elLast  = $('p-last-activity');
          const { firstToday, lastActivity } = logonStats(logons);
          if (elFirst) elFirst.textContent = firstToday
            ? `1ère connexion : ${fmtTime(firstToday.lastLogOnDateTime)}`
            : '1ère connexion : —';
          if (elLast) elLast.textContent = lastActivity
            ? `Dernière activité : ${fmtDateTime(lastActivity.lastLogOnDateTime)}`
            : 'Dernière activité : —';
        })
        .catch(() => {
          const elFirst = $('p-first-login');
          const elLast  = $('p-last-activity');
          if (elFirst) elFirst.textContent = '1ère connexion : —';
          if (elLast)  elLast.textContent  = 'Dernière activité : —';
        });
    } else {
      $('p-user').innerHTML = '<span style="color:var(--text-muted);font-size:12px">Aucun utilisateur associé</span>';
    }

    // Matériel
    $('p-hardware').innerHTML = '<span class="blink">Chargement…</span>';
    api(`/api/inventory/${d.id}`)
      .then(hw => {
        const total = hw.totalStorageSpaceInBytes || 0;
        const used  = total - (hw.freeStorageSpaceInBytes || 0);
        const pct   = total ? Math.round(used / total * 100) : 0;
        const cls   = pct < 60 ? 'low' : pct < 85 ? 'mid' : 'high';
        const ram   = hw.physicalMemoryInBytes;
        let html = '';
        if (total) html += `
          <div class="metric">
            <div class="metric-head">
              <span class="mlabel">Stockage</span>
              <span class="mval">${bytes(used)} / ${bytes(total)} &middot; ${pct}%</span>
            </div>
            <div class="bar"><div class="fill ${cls}" style="width:${pct}%"></div></div>
          </div>`;
        if (ram) html += `
          <div class="metric">
            <div class="metric-head">
              <span class="mlabel">RAM</span>
              <span class="ram-tag">${bytes(ram)}</span>
            </div>
          </div>`;
        if (!total && !ram) html = '<span style="color:var(--text-muted);font-size:12px">Données matérielles non disponibles</span>';
        $('p-hardware').innerHTML = html;
      })
      .catch(() => { $('p-hardware').innerHTML = '<span style="color:var(--text-muted);font-size:12px">—</span>'; });

    // Sécurité — Defender
    $('p-av-badge').className = 'sec-badge loading';
    $('p-av-badge').textContent = 'Chargement Defender…';
    api(`/api/devices/${d.id}/protection`)
      .then(p => {
        const el = $('p-av-badge');
        const avOk   = p.antivirusEnabled !== false && p.malwareProtectionEnabled !== false && p.realTimeProtectionEnabled !== false;
        const issues = [];
        if (p.antivirusEnabled === false)          issues.push('Antivirus désactivé');
        if (p.realTimeProtectionEnabled === false) issues.push('Protection temps réel off');
        if (p.signatureUpdateOverdue === true)     issues.push('Signatures obsolètes');
        if (p.quickScanOverdue === true || p.fullScanOverdue === true) issues.push('Scan en retard');
        if (!avOk || issues.some(i => i.includes('désactivé') || i.includes('off'))) {
          el.className = 'sec-badge danger';
          el.innerHTML = `<span class="sec-dot"></span> ${issues[0] || 'Protection inactive'}`;
        } else if (issues.length) {
          el.className = 'sec-badge warn';
          el.innerHTML = `<span class="sec-dot"></span> ${issues.join(' · ')}`;
        } else {
          el.className = 'sec-badge ok';
          el.innerHTML = '<span class="sec-dot"></span> Defender OK';
        }
      })
      .catch(() => {
        $('p-av-badge').className = 'sec-badge unavail';
        $('p-av-badge').textContent = 'Defender : données non disponibles';
      });

    // Sécurité — Vulnérabilités critiques Microsoft
    const vulnEl = $('p-vuln-badge');
    vulnEl.className = 'sec-badge loading';
    vulnEl.innerHTML = `
      <span>Analyse des vulnérabilités…</span>
      <div class="vuln-progress-wrap"><div class="vuln-progress-bar indeterminate"></div></div>`;
    $('p-vuln-detail').style.display = 'none';
    $('p-vuln-detail').innerHTML = '';
    if (d.deviceName) {
      api(`/api/security/${encodeURIComponent(d.deviceName)}/criticalVulns`)
        .then(({ count, breakdown }) => {
          const el = $('p-vuln-badge');
          if (count === null) {
            el.className = 'sec-badge unavail';
            el.textContent = 'Vulnérabilités : appareil non onboardé MDE';
          } else if (count === 0) {
            el.className = 'sec-badge ok';
            el.innerHTML = '<span class="sec-dot"></span> 0 vulnérabilité critique Microsoft';
          } else {
            el.className = 'sec-badge danger clickable';
            el.title = 'Cliquer pour ajouter au groupe Autopatch Test';
            el.innerHTML = `<span class="sec-dot"></span> ${count} vulnérabilité${count > 1 ? 's' : ''} critique${count > 1 ? 's' : ''} Microsoft — <u>Ajouter au groupe test</u>`;
            el.onclick = async () => {
              if (!d.azureADDeviceId) return;
              el.className = 'sec-badge loading';
              el.textContent = 'Ajout en cours…';
              el.onclick = null;
              try {
                await addToAutopatchById(d.azureADDeviceId);
                el.className = 'sec-badge added';
                el.innerHTML = '<span class="sec-dot"></span> Ajouté au groupe Autopatch Test';
              } catch(e) {
                el.className = 'sec-badge warn';
                el.textContent = `Erreur : ${e.message}`;
              }
            };

            // Tableau de détail par logiciel
            if (breakdown && breakdown.length) {
              const detail = $('p-vuln-detail');
              detail.style.display = '';
              detail.innerHTML = `
                <table class="vuln-table">
                  <thead><tr><th>Logiciel Microsoft</th><th>CVE critiques</th></tr></thead>
                  <tbody>
                    ${breakdown.map(s => `
                      <tr>
                        <td>${s.name}</td>
                        <td><span class="vuln-count">${s.criticalCount}</span></td>
                      </tr>`).join('')}
                  </tbody>
                </table>`;
            }
          }
        })
        .catch(e => {
          $('p-vuln-badge').className = 'sec-badge warn';
          $('p-vuln-badge').textContent = `Vulnérabilités : erreur (${e.message})`;
        });
    } else {
      vulnEl.className = 'sec-badge unavail';
      vulnEl.textContent = 'Vulnérabilités : non disponibles';
    }

    // ── LAPS
    const lapsEl = $('p-laps');
    lapsEl.innerHTML = '<button class="btn-reveal" id="p-laps-btn">Révéler le mot de passe</button>';
    $('p-laps-btn').addEventListener('click', async function() {
      if (!d.azureADDeviceId) { lapsEl.textContent = 'ID Azure AD manquant'; return; }
      this.disabled = true; this.textContent = '…';
      try {
        const data = await api(`/api/security/laps/${d.azureADDeviceId}`);
        if (!data || !data.credentials?.length) {
          lapsEl.innerHTML = '<span style="color:var(--text-muted);font-size:12px">Aucune donnée LAPS disponible</span>';
          return;
        }
        const cred = data.credentials[0];
        const lapsPwd = cred.passwordBase64 ? atob(cred.passwordBase64) : null;
        lapsEl.innerHTML = `<div class="cred-block"></div>`;
        const block = lapsEl.querySelector('.cred-block');
        [
          ['Compte', cred.accountName || 'Administrator', false],
          ['Mot de passe', lapsPwd, true],
          ['Sauvegardé le', fmtDateTime(cred.backupDateTime), false],
        ].forEach(([label, val, copyable]) => {
          const row = document.createElement('div');
          row.className = 'cred-row';
          row.innerHTML = `<span class="cred-label">${label}</span><span class="cred-val">${val || '—'}</span>`;
          if (copyable && val) {
            const btn = document.createElement('button');
            btn.className = 'btn-copy'; btn.textContent = 'Copier';
            btn.addEventListener('click', () => {
              navigator.clipboard.writeText(val);
              btn.textContent = 'Copié'; btn.classList.add('copied');
              setTimeout(() => { btn.textContent = 'Copier'; btn.classList.remove('copied'); }, 2000);
            });
            row.appendChild(btn);
          }
          block.appendChild(row);
        });
      } catch(e) {
        lapsEl.innerHTML = `<span style="color:var(--red);font-size:12px">Erreur : ${e.message}</span>`;
      }
    });

    // ── BitLocker
    const blEl = $('p-bitlocker');
    blEl.innerHTML = '<button class="btn-reveal" id="p-bl-btn">Révéler les clés BitLocker</button>';
    $('p-bl-btn').addEventListener('click', async function() {
      if (!d.azureADDeviceId) { blEl.textContent = 'ID Azure AD manquant'; return; }
      this.disabled = true; this.textContent = '…';
      try {
        const keys = await api(`/api/security/bitlocker/${d.azureADDeviceId}`);
        if (!keys.length) {
          blEl.innerHTML = '<span style="color:var(--text-muted);font-size:12px">Aucune clé BitLocker trouvée</span>';
          return;
        }
        const block = document.createElement('div');
        block.className = 'cred-block';
        keys.forEach(k => {
          const row = document.createElement('div');
          row.className = 'cred-row';
          row.innerHTML = `
            <span class="cred-label">${k.volumeType || 'Volume'}<br><span style="font-weight:400;text-transform:none;letter-spacing:0">${fmtDate(k.createdDateTime)}</span></span>
            <span class="cred-val">${k.key || '—'}</span>
          `;
          if (k.key) {
            const btn = document.createElement('button');
            btn.className = 'btn-copy'; btn.textContent = 'Copier';
            btn.addEventListener('click', () => {
              navigator.clipboard.writeText(k.key);
              btn.textContent = 'Copié'; btn.classList.add('copied');
              setTimeout(() => { btn.textContent = 'Copier'; btn.classList.remove('copied'); }, 2000);
            });
            row.appendChild(btn);
          }
          block.appendChild(row);
        });
        blEl.innerHTML = '';
        blEl.appendChild(block);
      } catch(e) {
        blEl.innerHTML = `<span style="color:var(--red);font-size:12px">Erreur : ${e.message}</span>`;
      }
    });

    $('panel').classList.add('open');
    $('main').classList.add('shifted');
  }

  function closePanel() {
    $('panel').classList.remove('open');
    $('main').classList.remove('shifted');
    if (selRow) { selRow.classList.remove('sel'); selRow = null; }
  }

  // ── NAVIGATE TO DEVICE
  function navigateToDevice(id) {
    document.querySelector('.tab[data-tab="devices"]').click();
    const device = devices.find(d => d.id === id);
    if (!device) return;
    const tr = document.querySelector(`#dev-body tr[data-id="${id}"]`);
    if (tr) openPanel(device, tr);
  }

  // ── AUTOPATCH
  async function loadAutopatch() {
    $('ap-loading').style.display = 'flex';
    $('ap-members-wrap').style.display = 'none';
    try {
      const [members, cfg] = await Promise.all([
        api('/api/autopatch/members'),
        api('/api/autopatch/config'),
      ]);
      autopatchMembers = members;
      $('ap-group-name').textContent = `Groupe : ${cfg.groupName}`;
    } catch(e) {
      $('ap-loading').innerHTML = `<span style="color:var(--red)">Erreur : ${e.message}</span>`;
      return;
    }
    $('ap-loading').style.display = 'none';
    $('ap-members-wrap').style.display = '';
    renderAutopatch();
    populateAutopatchSelect();
  }

  function renderAutopatch() {
    const list = $('ap-members-list');
    list.innerHTML = '';
    $('ap-empty').style.display = autopatchMembers.length ? 'none' : '';
    autopatchMembers.forEach(m => {
      const div = document.createElement('div');
      div.className = 'ap-member';
      div.innerHTML = `
        <div class="ap-member-name">${m.displayName || '—'}</div>
        <button class="btn-remove" data-id="${m.id}">Retirer</button>
      `;
      div.querySelector('.btn-remove').addEventListener('click', async function() {
        this.disabled = true; this.textContent = '…';
        try {
          await api(`/api/autopatch/members/${m.id}`, { method: 'DELETE' });
          autopatchMembers = autopatchMembers.filter(x => x.id !== m.id);
          renderAutopatch();
          populateAutopatchSelect();
        } catch(e) {
          alert(`Erreur : ${e.message}`);
          this.disabled = false; this.textContent = 'Retirer';
        }
      });
      list.appendChild(div);
    });
  }

  function populateAutopatchSelect() {
    const sel = $('ap-add-sel');
    const memberIds = new Set(autopatchMembers.map(m => (m.deviceId || '').toLowerCase()));
    sel.innerHTML = '<option value="">Choisir un appareil à ajouter…</option>';
    [...devices]
      .filter(d => d.azureADDeviceId && !memberIds.has(d.azureADDeviceId.toLowerCase()))
      .sort((a, b) => (a.deviceName || '').localeCompare(b.deviceName || '', 'fr'))
      .forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.azureADDeviceId;
        opt.textContent = d.deviceName;
        sel.appendChild(opt);
      });
  }

  async function addToAutopatchById(azureADDeviceId) {
    const r = await api('/api/autopatch/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ azureADDeviceId })
    });
    autopatchMembers = await api('/api/autopatch/members');
    renderAutopatch();
    populateAutopatchSelect();
    return r;
  }

  $('ap-add-btn').addEventListener('click', async () => {
    const sel = $('ap-add-sel');
    const azureADDeviceId = sel.value;
    if (!azureADDeviceId) return;
    const btn = $('ap-add-btn');
    btn.disabled = true; btn.textContent = '…';
    try {
      await addToAutopatchById(azureADDeviceId);
    } catch(e) {
      alert(`Erreur lors de l'ajout : ${e.message}`);
    }
    btn.disabled = false; btn.textContent = 'Ajouter';
  });

  // ── USER SEARCH
  async function searchUsers() {
    const q = $('q-user').value.trim();
    if (q.length < 2) return;
    const btn = $('btn-user-search');
    btn.disabled = true; btn.textContent = '…';
    $('user-results').innerHTML = '<div class="loading" style="padding:24px 0"><div class="spinner"></div><span>Recherche…</span></div>';
    $('user-devices-section').style.display = 'none';
    activeUserCard = null;
    try {
      const users = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
      if (!users.length) {
        $('user-results').innerHTML = '<div class="empty" style="padding:24px 0;text-align:left">Aucun utilisateur trouvé.</div>';
      } else {
        $('user-results').innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'user-results';
        users.forEach(u => {
          const name = u.displayName || u.userPrincipalName || '—';
          const card = document.createElement('div');
          card.className = 'user-result-card';
          card.innerHTML = `
            <div class="avatar">${initials(name)}</div>
            <div style="min-width:0">
              <div class="u-name">${name}</div>
              <div class="u-upn">${u.userPrincipalName || u.mail || ''}</div>
            </div>
          `;
          card.addEventListener('click', () => loadUserDevices(u, card));
          wrap.appendChild(card);
        });
        $('user-results').appendChild(wrap);
      }
    } catch(e) {
      $('user-results').innerHTML = `<div style="color:var(--red);font-size:12px">Erreur : ${e.message}</div>`;
    }
    btn.disabled = false; btn.textContent = 'Rechercher';
  }

  async function loadUserDevices(user, card) {
    if (activeUserCard) activeUserCard.classList.remove('active');
    activeUserCard = card; card.classList.add('active');

    const name = user.displayName || user.userPrincipalName || '—';
    $('ud-username').textContent = name;
    $('ud-count').textContent = '';
    $('ud-cards').innerHTML = '<div class="loading" style="padding:20px 0"><div class="spinner"></div></div>';
    $('ud-empty').style.display = 'none';
    $('user-devices-section').style.display = '';

    // Tickets GLPI ouverts
    const glpiEl = $('ud-glpi');
    glpiEl.innerHTML = '<span class="blink">…</span>';
    const email = user.mail || user.userPrincipalName || '';
    api(`/api/users/${user.id}/glpi-tickets?email=${encodeURIComponent(email)}`)
      .then(({ count, reason }) => {
        if (count === null) {
          glpiEl.innerHTML = reason === 'not_configured'
            ? '<span class="glpi-badge na">GLPI non configuré</span>'
            : '<span class="glpi-badge na">Indisponible</span>';
        } else if (count === 0) {
          glpiEl.innerHTML = '<span class="glpi-badge ok">0 ticket ouvert</span>';
        } else {
          glpiEl.innerHTML = `<span class="glpi-badge warn">${count} ticket${count > 1 ? 's' : ''} ouvert${count > 1 ? 's' : ''}</span>`;
        }
      })
      .catch(() => { glpiEl.innerHTML = '<span class="glpi-badge na">—</span>'; });

    try {
      const devs = await api(`/api/users/${user.id}/devices`);
      $('ud-count').textContent = `${devs.length} appareil${devs.length!==1?'s':''}`;
      $('ud-cards').innerHTML = '';

      if (!devs.length) {
        $('ud-empty').style.display = '';
        return;
      }

      devs.forEach((d, i) => {
        const old = stale(d.lastSyncDateTime);
        const safeId = d.id.replace(/[^a-z0-9]/gi, '');
        const card = document.createElement('div');
        card.className = 'ud-card';
        card.style.animationDelay = `${i * 0.06}s`;
        card.innerHTML = `
          <div class="ud-card-head">
            <div class="ud-card-name-wrap">
              <div class="ud-card-name">
                <span>${osIcon(d.operatingSystem)}</span>
                ${d.deviceName || '—'}
              </div>
              <div class="ud-card-os">${d.operatingSystem || '—'}${d.osVersion ? ' · ' + d.osVersion : ''}</div>
            </div>
            <button class="btn-goto" data-id="${d.id}">Voir dans Appareils →</button>
          </div>
          <div class="ud-card-grid">
            <div class="ud-card-field">
              <div class="ud-card-label">Fabricant</div>
              <div class="ud-card-val">${d.manufacturer || '—'}</div>
            </div>
            <div class="ud-card-field">
              <div class="ud-card-label">Modèle</div>
              <div class="ud-card-val">${d.model || '—'}</div>
            </div>
            <div class="ud-card-field">
              <div class="ud-card-label">N° de série</div>
              <div class="ud-card-val">${d.serialNumber || '—'}</div>
            </div>
            <div class="ud-card-field">
              <div class="ud-card-label">Enrollé le</div>
              <div class="ud-card-val">${fmtDate(d.enrolledDateTime)}</div>
            </div>
            <div class="ud-card-field">
              <div class="ud-card-label">Dernière sync</div>
              <div class="ud-card-val ${old ? 'old' : 'ok'}">${ago(d.lastSyncDateTime)}</div>
            </div>
            <div class="ud-card-field">
              <div class="ud-card-label">ID Azure AD</div>
              <div class="ud-card-val" style="font-size:10px;word-break:break-all">${d.azureADDeviceId || '—'}</div>
            </div>
          </div>
          <hr class="ud-card-divider">
          <div class="ud-card-activity">
            <div class="ud-card-field">
              <div class="ud-card-label">1ère connexion aujourd'hui</div>
              <div class="ud-card-val" id="ud-first-${safeId}"><span class="blink">…</span></div>
            </div>
            <div class="ud-card-field">
              <div class="ud-card-label">Dernière activité</div>
              <div class="ud-card-val" id="ud-last-${safeId}"><span class="blink">…</span></div>
            </div>
          </div>`;

        card.querySelector('.btn-goto').addEventListener('click', () => navigateToDevice(d.id));
        $('ud-cards').appendChild(card);
      });

      // Sign-in log des 7 derniers jours
      $('ud-signins').style.display = 'none';
      $('ud-signins-body').innerHTML = '<div class="loading" style="padding:12px 0"><div class="spinner"></div></div>';
      api(`/api/users/${user.id}/signins?days=7`)
        .then(signins => {
          const wrap = $('ud-signins-body');
          if (!signins.length) {
            wrap.innerHTML = '<div class="empty" style="padding:10px 0;font-size:12px">Aucune connexion sur 7 jours.</div>';
          } else {
            const rows = signins.map(s => {
              const ok = s.status?.errorCode === 0;
              const loc = [s.location?.city, s.location?.countryOrRegion].filter(Boolean).join(', ') || '—';
              const app = s.appDisplayName || s.clientAppUsed || '—';
              const dev = s.deviceDetail?.displayName || '—';
              return `<tr>
                <td class="muted" style="white-space:nowrap">${fmtDateTime(s.createdDateTime)}</td>
                <td>${app}</td>
                <td class="muted">${dev}</td>
                <td class="muted">${s.ipAddress || '—'}</td>
                <td class="muted">${loc}</td>
                <td><span class="signin-status ${ok ? 'ok' : 'fail'}">${ok ? 'Succès' : 'Échec'}</span></td>
              </tr>`;
            }).join('');
            wrap.innerHTML = `
              <div class="table-wrap" style="margin-top:0">
                <table class="signin-table">
                  <thead><tr>
                    <th>Date / Heure</th><th>Application</th><th>Appareil</th>
                    <th>IP</th><th>Localisation</th><th>Statut</th>
                  </tr></thead>
                  <tbody>${rows}</tbody>
                </table>
              </div>`;
          }
          $('ud-signins').style.display = '';
        })
        .catch(() => {
          $('ud-signins-body').innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 0">Sign-in log non disponible (permission AuditLog.Read.All requise).</div>';
          $('ud-signins').style.display = '';
        });

      // Logons en parallèle
      devs.forEach(d => {
        const safeId = d.id.replace(/[^a-z0-9]/gi, '');
        api(`/api/devices/${d.id}/logons`)
          .then(logons => {
            const { firstToday, lastActivity } = logonStats(logons);
            const elF = document.getElementById(`ud-first-${safeId}`);
            const elL = document.getElementById(`ud-last-${safeId}`);
            if (elF) elF.textContent = firstToday ? fmtTime(firstToday.lastLogOnDateTime) : '—';
            if (elL) elL.textContent = lastActivity ? fmtDateTime(lastActivity.lastLogOnDateTime) : '—';
          })
          .catch(() => {
            const elF = document.getElementById(`ud-first-${safeId}`);
            const elL = document.getElementById(`ud-last-${safeId}`);
            if (elF) elF.textContent = '—';
            if (elL) elL.textContent = '—';
          });
      });

    } catch(e) {
      $('ud-cards').innerHTML = `<div style="color:var(--red);font-size:12px;padding:12px 0">Erreur : ${e.message}</div>`;
    }
  }

  $('btn-user-search').addEventListener('click', searchUsers);
  $('q-user').addEventListener('keydown', e => { if (e.key === 'Enter') searchUsers(); });

  // ── TABS
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      closePanel();
      const tab = btn.dataset.tab;
      $('v-devices').style.display     = tab==='devices'     ? '' : 'none';
      $('v-user-search').style.display = tab==='user-search' ? '' : 'none';
      $('v-autopatch').style.display   = tab==='autopatch'   ? '' : 'none';
      if (tab === 'autopatch') loadAutopatch();
    });
  });

  // ── SEARCH
  $('q-dev').addEventListener('input', e => {
    const f = filterDev(e.target.value);
    renderDevices(f);
    $('badge-dev').textContent = `${f.length} appareil${f.length!==1?'s':''}`;
    $('dev-table').style.display = f.length ? '' : 'none';
    $('dev-empty').style.display = f.length ? 'none' : '';
  });

  // ── CLOSE
  $('p-close').addEventListener('click', closePanel);

  // ── SORT
  document.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) {
        sortDir *= -1;
      } else {
        sortCol = col;
        sortDir = 1;
      }
      document.querySelectorAll('th[data-col]').forEach(t => t.classList.remove('sort-asc', 'sort-desc'));
      th.classList.add(sortDir === 1 ? 'sort-asc' : 'sort-desc');
      const f = filterDev($('q-dev').value);
      renderDevices(f);
    });
  });

  // ── INIT
  loadDevices();
