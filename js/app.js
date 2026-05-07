/* AD13 Cartography - charge instruments_recherche_AD13.json et affiche
   un inventaire complet + visualisations (sunburst, barres, stats) */

const SERIES_COLORS = {
  A: '#e53e3e', B: '#dd6b20', C: '#d69e2e', D: '#38a169', E: '#319795',
  G: '#3182ce', H: '#5a67d8', J: '#805ad5', L: '#d53f8c', M: '#ed64a6',
  N: '#f56565', O: '#48bb78', P: '#38b2ac', Q: '#4299e1', R: '#667eea',
  S: '#7646ff', T: '#a0aec0', U: '#718096', V: '#4fd1c5', W: '#f6ad55',
  X: '#68d391', Y: '#fc8181', Z: '#b794f4',
  HD: '#81e6d9', E_ETP: '#f687b3', FI: '#faf089', K: '#fbd38d'
};

class AD13Cartography {
  constructor(data) {
    this.data = data;
    this.currentFilter = 'all';
    this.currentTheme = null;
    this.searchTerm = '';
    this.allInstruments = [];
    this.init();
  }

  init() {
    this.normalizeColors();
    this.collectAllInstruments();
    this.buildSearchIndex();
    this.buildHierarchy();
    this.buildSeriesButtons();
    this.renderStats();
    this.createTreemap();
    this.createBarChart();
    this.setupEventListeners();
    this.updateResults();
  }

  normalizeColors() {
    const series = this.data.cadre_classement.series;
    Object.keys(series).forEach(k => {
      series[k].color = series[k].color || SERIES_COLORS[k] || '#718096';
    });
    Object.keys(this.data.series_speciales || {}).forEach(k => {
      const key = k.toUpperCase();
      this.data.series_speciales[k].color =
        this.data.series_speciales[k].color || SERIES_COLORS[key] || '#718096';
    });
  }

  collectAllInstruments() {
    // Build a map keyed by cote+eadid to avoid duplicates between
    // series.instruments and series.thematiques.cotes (especially for W).
    const byKey = new Map();
    const series = this.data.cadre_classement.series;

    const keyOf = (i) => (i.eadid || '') + '|' + (i.cote || i.name || '');

    // Pass 1: thematiques first (to attach theme info)
    Object.keys(series).forEach(key => {
      const s = series[key];
      const them = s.thematiques || {};
      Object.keys(them).forEach(tk => {
        const t = them[tk];
        (t.cotes || []).forEach(c => {
          byKey.set(keyOf(c), {
            ...c, series: key, seriesIntitule: s.intitule,
            theme: tk, themeName: t.intitule, color: s.color
          });
        });
      });
    });

    // Pass 2: series.instruments (don't override existing theme assignment)
    Object.keys(series).forEach(key => {
      const s = series[key];
      (s.instruments || []).forEach(i => {
        const k = keyOf(i);
        if (byKey.has(k)) return;
        byKey.set(k, {
          ...i, series: key, seriesIntitule: s.intitule, color: s.color
        });
      });
    });

    // Pass 3: special series
    Object.keys(this.data.series_speciales || {}).forEach(key => {
      const s = this.data.series_speciales[key];
      (s.instruments || []).forEach(i => {
        const k = keyOf(i);
        if (byKey.has(k)) return;
        byKey.set(k, {
          ...i, series: key.toUpperCase(),
          seriesIntitule: s.intitule, color: s.color, special: true
        });
      });
    });

    this.allInstruments = Array.from(byKey.values());
  }

  // Normalisation pour la recherche : minuscules, sans accents,
  // ligatures simplifiées, espaces unifiés.
  normalize(str) {
    if (str == null) return '';
    return ('' + str)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[’‘ʼ´`]/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  buildSearchIndex() {
    // Concatène tous les champs textuels d'un instrument dans une seule chaîne
    // normalisée, stockée dans _idx pour accélérer la recherche.
    const fields = [
      'cote', 'name', 'description', 'fullName',
      'producteur', 'producer', 'origination',
      'themeName', 'seriesIntitule', 'series',
      'periode', 'periode_normal', 'unitdate',
      'extent', 'physloc', 'scopecontent',
      'auteur_ir', 'titre_ir', 'eadid', 'url'
    ];
    this.allInstruments.forEach(i => {
      const parts = [];
      fields.forEach(f => { if (i[f]) parts.push(i[f]); });
      i._idx = this.normalize(parts.join(' · '));
    });
  }

  countsBySeries() {
    const counts = {};
    this.allInstruments.forEach(i => {
      counts[i.series] = (counts[i.series] || 0) + 1;
    });
    // Inclure aussi les séries sans instruments listés
    Object.keys(this.data.cadre_classement.series).forEach(k => {
      counts[k] = counts[k] || 0;
    });
    return counts;
  }

  buildHierarchy() {
    // Hiérarchie pour le sunburst : 3 niveaux
    //   AD13 -> Série -> (thématiques pour W / tranche numérique sinon)
    // On agrège les cotes en buckets pour rester lisible avec ~950 IR.
    const hierarchy = { name: 'AD13', children: [] };
    const series = this.data.cadre_classement.series;

    const bucketLabel = (n) => {
      if (n < 100) return '< 100';
      if (n < 500) return '100-499';
      if (n < 1000) return '500-999';
      if (n < 1500) return '1000-1499';
      if (n < 2000) return '1500-1999';
      if (n < 2500) return '2000-2499';
      if (n < 3000) return '2500-2999';
      if (n < 3500) return '3000-3499';
      return '≥ 3500';
    };

    const numFromCote = (cote) => {
      const m = (cote || '').match(/^\s*(\d+)/);
      return m ? parseInt(m[1], 10) : null;
    };

    Object.keys(series).forEach(seriesKey => {
      const s = series[seriesKey];
      const node = {
        name: seriesKey, fullName: s.intitule,
        description: s.description, periode: s.periode,
        color: s.color, children: [], _instrumentCount: (s.instruments || []).length
      };

      // For W: group by thematique (classed) + buckets for the rest
      if (seriesKey === 'W' && s.thematiques) {
        const claimed = new Set();
        Object.keys(s.thematiques).forEach(tk => {
          const t = s.thematiques[tk];
          (t.cotes || []).forEach(c => claimed.add(c.eadid + '|' + c.cote));
        });
        // thematique nodes (each weighted by cote count)
        Object.keys(s.thematiques).forEach(tk => {
          const t = s.thematiques[tk];
          const cnt = (t.cotes || []).length;
          if (cnt === 0) return;
          node.children.push({
            name: t.intitule, fullName: t.intitule,
            description: t.description,
            color: this.adjustColor(s.color, 15),
            value: cnt,
            isLeaf: true
          });
        });
        // remaining W as numeric buckets
        const remaining = (s.instruments || []).filter(i => !claimed.has((i.eadid||'') + '|' + i.cote));
        const buckets = {};
        remaining.forEach(i => {
          const n = numFromCote(i.cote);
          if (n == null) return;
          const lbl = bucketLabel(n);
          buckets[lbl] = (buckets[lbl] || 0) + 1;
        });
        Object.keys(buckets).sort().forEach(lbl => {
          node.children.push({
            name: lbl + ' W', fullName: 'Autres versements W (' + lbl + ')',
            description: 'Versements W cotés ' + lbl + ' (non rattachés aux thématiques principales)',
            color: this.adjustColor(s.color, 30),
            value: buckets[lbl],
            isLeaf: true
          });
        });
      } else if ((s.instruments || []).length > 12) {
        // bucket par tranches numériques
        const buckets = {};
        (s.instruments || []).forEach(i => {
          const n = numFromCote(i.cote);
          const lbl = (n == null) ? 'autre' : bucketLabel(n);
          buckets[lbl] = (buckets[lbl] || 0) + 1;
        });
        Object.keys(buckets).sort().forEach(lbl => {
          node.children.push({
            name: `${lbl} ${seriesKey}`, fullName: `Série ${seriesKey} — ${lbl}`,
            description: `Versements de la série ${seriesKey} cotés ${lbl}`,
            color: this.adjustColor(s.color, 25),
            value: buckets[lbl],
            isLeaf: true
          });
        });
      } else {
        (s.instruments || []).forEach(inst => {
          node.children.push({
            name: inst.cote, fullName: inst.description,
            description: inst.description,
            periode: inst.periode || s.periode,
            producer: inst.producteur,
            color: this.adjustColor(s.color, 25),
            value: 1, isLeaf: true
          });
        });
      }

      // série sans instruments : noeud factice avec valeur 1 pour qu'il apparaisse
      if (node.children.length === 0) {
        node.children.push({
          name: '—', fullName: 'Aucun instrument cartographié',
          color: this.adjustColor(s.color, 40),
          value: 1, isLeaf: true, isPlaceholder: true
        });
      }
      hierarchy.children.push(node);
    });

    Object.keys(this.data.series_speciales || {}).forEach(key => {
      const s = this.data.series_speciales[key];
      const node = {
        name: key.toUpperCase(), fullName: s.intitule,
        description: s.description, color: s.color, children: [],
        _instrumentCount: (s.instruments || []).length
      };
      const insts = s.instruments || [];
      if (insts.length > 12) {
        const buckets = {};
        insts.forEach(i => {
          const n = numFromCote(i.cote);
          const lbl = (n == null) ? 'autre' : bucketLabel(n);
          buckets[lbl] = (buckets[lbl] || 0) + 1;
        });
        Object.keys(buckets).sort().forEach(lbl => {
          node.children.push({
            name: `${lbl} ${key.toUpperCase()}`,
            fullName: `${s.intitule} — ${lbl}`,
            color: this.adjustColor(s.color, 25),
            value: buckets[lbl], isLeaf: true
          });
        });
      } else {
        insts.forEach(inst => {
          node.children.push({
            name: inst.cote, fullName: inst.description,
            description: inst.description, periode: inst.periode,
            producer: inst.producteur,
            color: this.adjustColor(s.color, 25),
            value: 1, isLeaf: true
          });
        });
      }
      if (node.children.length === 0) {
        node.children.push({
          name: '—', fullName: 'Aucun instrument',
          color: this.adjustColor(s.color, 40),
          value: 1, isLeaf: true, isPlaceholder: true
        });
      }
      hierarchy.children.push(node);
    });

    this.hierarchy = hierarchy;
  }

  adjustColor(hex, percent) {
    const num = parseInt(hex.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    let R = (num >> 16) + amt;
    let G = ((num >> 8) & 0xFF) + amt;
    let B = (num & 0xFF) + amt;
    R = Math.max(0, Math.min(255, R));
    G = Math.max(0, Math.min(255, G));
    B = Math.max(0, Math.min(255, B));
    return '#' + ((R << 16) | (G << 8) | B).toString(16).padStart(6, '0');
  }

  renderStats() {
    const el = document.getElementById('statsBar');
    if (!el) return;
    const series = this.data.cadre_classement.series;
    const totalSeries = Object.keys(series).length
      + Object.keys(this.data.series_speciales || {}).length;
    const totalInstruments = this.allInstruments.length;
    const totalThemes = Object.values(series)
      .reduce((n, s) => n + Object.keys(s.thematiques || {}).length, 0);
    const seriesAvecInstruments = new Set(this.allInstruments.map(i => i.series)).size;

    el.innerHTML = `
      <div class="stat"><div class="stat-num">${totalSeries}</div><div class="stat-lbl">Séries</div></div>
      <div class="stat"><div class="stat-num">${totalInstruments}</div><div class="stat-lbl">Instruments</div></div>
      <div class="stat"><div class="stat-num">${totalThemes}</div><div class="stat-lbl">Thématiques W</div></div>
      <div class="stat"><div class="stat-num">${seriesAvecInstruments}</div><div class="stat-lbl">Séries documentées</div></div>
    `;
  }

  buildSeriesButtons() {
    const container = document.getElementById('seriesButtons');
    const series = this.data.cadre_classement.series;
    container.innerHTML = '<button class="series-btn active" data-series="all">Toutes</button>';
    Object.keys(series).forEach(key => {
      const btn = document.createElement('button');
      btn.className = 'series-btn';
      btn.dataset.series = key;
      btn.textContent = key;
      btn.style.borderColor = series[key].color;
      btn.style.color = series[key].color;
      btn.title = series[key].intitule;
      container.appendChild(btn);
    });
    Object.keys(this.data.series_speciales || {}).forEach(key => {
      const btn = document.createElement('button');
      btn.className = 'series-btn';
      btn.dataset.series = key.toUpperCase();
      btn.textContent = key.toUpperCase();
      btn.style.borderColor = this.data.series_speciales[key].color;
      btn.style.color = this.data.series_speciales[key].color;
      btn.title = this.data.series_speciales[key].intitule;
      container.appendChild(btn);
    });
  }


  createTreemap() {
    // Treemap D3 avec compression douce (puissance 0.55) sur les comptes :
    // équivalent carré du circle pack précédent. W reste le plus grand bloc
    // mais les autres séries restent visibles et cliquables.
    const container = document.getElementById('sunburst');
    if (!container) return;
    d3.select(container).selectAll('*').remove();

    const W = 480, H = 480;
    const POWER = 0.55;

    const root = d3.hierarchy(this.hierarchy)
      .sum(d => Math.pow(d.value || 0, POWER))
      .sort((a, b) => b.value - a.value);

    d3.treemap()
      .size([W, H])
      .paddingOuter(d => d.depth === 0 ? 0 : 4)
      .paddingTop(d => d.depth === 1 ? 18 : 2)
      .paddingInner(2)
      .round(true)
      .tile(d3.treemapSquarify.ratio(1))(root);

    const svg = d3.select(container).append('svg')
      .attr('viewBox', `0 0 ${W} ${H}`)
      .attr('width', '100%').attr('height', '100%')
      .style('font', '11px Roboto, sans-serif');

    const tip = document.getElementById('tooltip');
    const series = root.children || [];

    const seriesG = svg.selectAll('g.serie').data(series).join('g')
      .attr('class', 'serie')
      .attr('transform', d => `translate(${d.x0},${d.y0})`);

    // Cadre série
    seriesG.append('rect')
      .attr('width', d => d.x1 - d.x0)
      .attr('height', d => d.y1 - d.y0)
      .attr('rx', 4)
      .attr('fill', d => d.data.color || '#718096')
      .attr('fill-opacity', 0.18)
      .attr('stroke', d => d.data.color || '#718096')
      .attr('stroke-width', 1.5)
      .style('cursor', 'pointer')
      .on('mouseover', (e, d) => {
        tip.innerHTML = `<strong>Série ${d.data.name}</strong> — ${d.data.fullName || ''}<br>${d.data._instrumentCount || 0} instrument(s)`;
        tip.classList.add('visible');
      })
      .on('mousemove', (e) => {
        tip.style.left = (e.clientX + 15) + 'px';
        tip.style.top = (e.clientY - 10) + 'px';
      })
      .on('mouseout', () => tip.classList.remove('visible'))
      .on('click', (e, d) => this.filterBySeries(d.data.name));

    // Sous-blocs (thematiques / tranches)
    const self = this;
    series.forEach((s, i) => {
      const sg = d3.select(seriesG.nodes()[i]);
      const subs = (s.children || []);
      const subG = sg.selectAll('g.sub').data(subs).join('g')
        .attr('class', 'sub')
        .attr('transform', d => `translate(${d.x0 - s.x0},${d.y0 - s.y0})`);

      subG.append('rect')
        .attr('width', d => d.x1 - d.x0)
        .attr('height', d => d.y1 - d.y0)
        .attr('rx', 2)
        .attr('fill', d => d.data.color || s.data.color)
        .attr('fill-opacity', 0.85)
        .attr('stroke', '#fff').attr('stroke-width', 0.6)
        .style('cursor', 'pointer')
        .on('mouseover', (e, d) => {
          tip.innerHTML = `<strong>${d.data.name}</strong><br>${d.data.fullName || d.data.description || ''}<br>${d.data.value || 1} IR`;
          tip.classList.add('visible');
        })
        .on('mousemove', (e) => {
          tip.style.left = (e.clientX + 15) + 'px';
          tip.style.top = (e.clientY - 10) + 'px';
        })
        .on('mouseout', () => tip.classList.remove('visible'))
        .on('click', (e) => { e.stopPropagation(); self.filterBySeries(s.data.name); });
    });

    // Label nom de série en haut du bloc
    seriesG.append('text')
      .attr('x', 6).attr('y', 13)
      .style('font-weight', '700')
      .style('font-size', d => {
        const w = d.x1 - d.x0;
        return Math.max(10, Math.min(14, w / 6)) + 'px';
      })
      .style('fill', d => d.data.color || '#2d3748')
      .style('pointer-events', 'none')
      .text(d => {
        const w = d.x1 - d.x0;
        if (w < 24) return '';
        const cnt = d.data._instrumentCount || 0;
        return `${d.data.name}${cnt && w > 60 ? '  · ' + cnt + ' IR' : ''}`;
      });
  }

  _unusedCirclePack() {
    // Circle packing avec compression douce (puissance ~0.55) sur les comptes :
    // les séries dominantes (W) restent les plus grosses bulles mais les petites
    // séries gardent une surface visible et cliquable.
    const container = document.getElementById('sunburst');
    if (!container) return;
    d3.select(container).selectAll('*').remove();

    const W = 480, H = 480;
    const svg = d3.select(container).append('svg')
      .attr('viewBox', `0 0 ${W} ${H}`)
      .attr('width', '100%').attr('height', '100%')
      .style('font', '11px Roboto, sans-serif');

    const POWER = 0.55; // compression : 1 = linéaire, 0.5 = sqrt

    // Construction d'un arbre 2 niveaux: AD13 -> Séries -> sous-groupes (buckets)
    const root = d3.hierarchy(this.hierarchy)
      .sum(d => Math.pow(d.value || 0, POWER))
      .sort((a, b) => b.value - a.value);

    const pack = d3.pack().size([W - 4, H - 4]).padding(d => d.depth === 1 ? 4 : 2);
    pack(root);

    const tip = document.getElementById('tooltip');
    const g = svg.append('g').attr('transform', 'translate(2,2)');

    // racine invisible
    // niveau 1 : séries
    const series = root.children || [];
    const seriesG = g.selectAll('g.serie').data(series).join('g')
      .attr('class', 'serie')
      .attr('transform', d => `translate(${d.x},${d.y})`);

    seriesG.append('circle')
      .attr('r', d => d.r)
      .attr('fill', d => d.data.color || '#718096')
      .attr('fill-opacity', 0.18)
      .attr('stroke', d => d.data.color || '#718096')
      .attr('stroke-width', 1.5)
      .style('cursor', 'pointer')
      .on('mouseover', (e, d) => {
        tip.innerHTML = `<strong>Série ${d.data.name}</strong> — ${d.data.fullName || ''}<br>${d.data._instrumentCount || d.value} instrument(s)`;
        tip.classList.add('visible');
      })
      .on('mousemove', (e) => {
        tip.style.left = (e.clientX + 15) + 'px';
        tip.style.top = (e.clientY - 10) + 'px';
      })
      .on('mouseout', () => tip.classList.remove('visible'))
      .on('click', (e, d) => this.filterBySeries(d.data.name));

    // niveau 2 : sous-groupes
    series.forEach(s => {
      const subG = d3.select(seriesG.nodes()[series.indexOf(s)]).selectAll('g.sub')
        .data(s.children || []).join('g')
        .attr('class', 'sub')
        .attr('transform', d => `translate(${d.x - s.x},${d.y - s.y})`);

      subG.append('circle')
        .attr('r', d => d.r)
        .attr('fill', d => d.data.color || s.data.color)
        .attr('fill-opacity', 0.85)
        .attr('stroke', '#fff').attr('stroke-width', 0.8)
        .style('cursor', 'pointer')
        .on('mouseover', (e, d) => {
          const cnt = d.data.value || 1;
          tip.innerHTML = `<strong>${d.data.name}</strong><br>${d.data.fullName || d.data.description || ''}<br>${cnt} IR`;
          tip.classList.add('visible');
        })
        .on('mousemove', (e) => {
          tip.style.left = (e.clientX + 15) + 'px';
          tip.style.top = (e.clientY - 10) + 'px';
        })
        .on('mouseout', () => tip.classList.remove('visible'))
        .on('click', (e, d) => {
          e.stopPropagation();
          this.filterBySeries(s.data.name);
        });
    });

    // labels: nom de série centré sur la bulle
    seriesG.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', d => d.r > 30 ? -d.r + 14 : 4)
      .style('font-weight', '700')
      .style('font-size', d => Math.max(10, Math.min(18, d.r / 2.5)) + 'px')
      .style('fill', d => d.data.color || '#2d3748')
      .style('pointer-events', 'none')
      .text(d => d.data.name);

    // count badge
    seriesG.filter(d => d.r > 22).append('text')
      .attr('text-anchor', 'middle').attr('dy', d => d.r > 30 ? -d.r + 28 : 16)
      .style('font-size', '9px').style('fill', '#4a5568')
      .style('pointer-events', 'none')
      .text(d => (d.data._instrumentCount || 0) + ' IR');
  }

  createBarChart() {
    const container = document.getElementById('barchart');
    if (!container) return;
    const counts = this.countsBySeries();
    const series = this.data.cadre_classement.series;
    const specials = this.data.series_speciales || {};

    const items = [
      ...Object.keys(series).map(k => ({
        key: k, label: k, intitule: series[k].intitule,
        count: counts[k] || 0, color: series[k].color
      })),
      ...Object.keys(specials).map(k => ({
        key: k.toUpperCase(), label: k.toUpperCase(),
        intitule: specials[k].intitule,
        count: counts[k.toUpperCase()] || 0, color: specials[k].color
      }))
    ].sort((a, b) => b.count - a.count);

    const W = 460, H = 360;
    const margin = { top: 10, right: 50, bottom: 10, left: 60 };
    d3.select(container).selectAll('*').remove();
    const svg = d3.select(container).append('svg')
      .attr('viewBox', `0 0 ${W} ${H}`).attr('width', '100%').attr('height', '100%');

    const x = d3.scaleLinear()
      .domain([0, d3.max(items, d => d.count) || 1])
      .range([margin.left, W - margin.right]);
    const y = d3.scaleBand()
      .domain(items.map(d => d.key))
      .range([margin.top, H - margin.bottom])
      .padding(0.15);

    svg.append('g').selectAll('text.lbl')
      .data(items).join('text')
      .attr('x', margin.left - 6).attr('y', d => y(d.key) + y.bandwidth()/2)
      .attr('text-anchor', 'end').attr('dy', '0.35em')
      .style('font-size', '10px').style('font-weight', '600')
      .style('fill', d => d.color).text(d => d.label);

    const tip = document.getElementById('tooltip');
    svg.append('g').selectAll('rect')
      .data(items).join('rect')
      .attr('x', margin.left).attr('y', d => y(d.key))
      .attr('width', d => Math.max(0, x(d.count) - margin.left))
      .attr('height', y.bandwidth())
      .attr('rx', 3)
      .attr('fill', d => d.color)
      .style('cursor', 'pointer')
      .on('mouseover', (e, d) => {
        tip.innerHTML = `<strong>Série ${d.label}</strong> — ${d.intitule}<br>${d.count} instrument(s)`;
        tip.classList.add('visible');
      })
      .on('mousemove', (e) => {
        tip.style.left = (e.clientX + 15) + 'px';
        tip.style.top = (e.clientY - 10) + 'px';
      })
      .on('mouseout', () => tip.classList.remove('visible'))
      .on('click', (e, d) => this.filterBySeries(d.key));

    svg.append('g').selectAll('text.val')
      .data(items).join('text')
      .attr('x', d => x(d.count) + 4)
      .attr('y', d => y(d.key) + y.bandwidth()/2)
      .attr('dy', '0.35em').style('font-size', '10px').style('fill', '#4a5568')
      .text(d => d.count || '');
  }

  filterBySeries(seriesKey) {
    this.currentFilter = seriesKey;
    document.querySelectorAll('.series-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.series === seriesKey);
    });
    this.updateResults();
    this.updateBreadcrumb(seriesKey);
  }

  showInstrument(instrument) {
    const panel = document.getElementById('detailsPanel');
    const content = document.getElementById('detailsContent');
    const cote = instrument.cote || instrument.name || '';
    content.innerHTML = `
      <h3>${instrument.fullName || instrument.description || cote}</h3>
      <div class="cote-display">${cote}</div>
      <div class="section">
        <div class="section-title">Description</div>
        <div class="section-content">${instrument.description || 'Non renseignée'}</div>
      </div>
      ${instrument.series ? `<div class="section"><div class="section-title">Série</div><div class="section-content">${instrument.series}${instrument.seriesIntitule ? ' — ' + instrument.seriesIntitule : ''}</div></div>` : ''}
      ${instrument.themeName ? `<div class="section"><div class="section-title">Thématique</div><div class="section-content">${instrument.themeName}</div></div>` : ''}
      ${instrument.periode ? `<div class="section"><div class="section-title">Période</div><div class="section-content">${instrument.periode}</div></div>` : ''}
      ${(instrument.producer || instrument.producteur) ? `<div class="section"><div class="section-title">Producteur</div><div class="section-content">${instrument.producer || instrument.producteur}</div></div>` : ''}
      <div class="section">
        <a href="https://www.archives13.fr/archive/recherche/fonds/n:93?Rech_cote=%22${encodeURIComponent(cote)}%22" target="_blank" class="action-link">Rechercher dans le catalogue</a>
      </div>
    `;
    panel.classList.add('open');
  }

  setupEventListeners() {
    document.getElementById('closeDetails').addEventListener('click', () => {
      document.getElementById('detailsPanel').classList.remove('open');
    });
    document.getElementById('seriesButtons').addEventListener('click', (e) => {
      const btn = e.target.closest('.series-btn');
      if (btn) this.filterBySeries(btn.dataset.series);
    });
    document.getElementById('searchInput').addEventListener('input', (e) => {
      this.searchTerm = this.normalize(e.target.value);
      this.updateResults();
    });
  }

  updateResults() {
    let filtered = [...this.allInstruments];
    if (this.currentFilter !== 'all') {
      filtered = filtered.filter(i => i.series === this.currentFilter);
    }
    if (this.currentTheme) {
      filtered = filtered.filter(i => i.theme === this.currentTheme);
    }
    if (this.searchTerm) {
      // Recherche multi-mots, insensible aux accents/casse, sur tous les champs.
      const tokens = this.searchTerm.split(/\s+/).filter(Boolean);
      filtered = filtered.filter(i => {
        const idx = i._idx || '';
        return tokens.every(tok => idx.includes(tok));
      });
    }

    const container = document.getElementById('resultsList');
    document.getElementById('resultsCount').textContent =
      `${filtered.length} instrument(s) sur ${this.allInstruments.length}`;

    container.innerHTML = filtered.map((item, idx) => `
      <div class="result-card" style="border-left-color: ${item.color || '#718096'}" data-idx="${idx}">
        <div class="cote">${item.cote || item.name || ''}</div>
        <div class="title">${item.description || item.fullName || ''}</div>
        <div class="meta">
          ${item.series ? `<span class="chip" style="background:${item.color}22;color:${item.color}">Série ${item.series}</span>` : ''}
          ${item.themeName ? `<span class="chip">${item.themeName}</span>` : ''}
          ${item.periode ? `<span>${item.periode}</span>` : ''}
          ${(item.producteur || item.producer) ? `<span>${item.producteur || item.producer}</span>` : ''}
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.result-card').forEach(card => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.dataset.idx, 10);
        this.showInstrument(filtered[idx]);
      });
    });
  }

  updateBreadcrumb(seriesKey) {
    const breadcrumb = document.getElementById('breadcrumb');
    if (!breadcrumb) return;
    if (seriesKey === 'all') { breadcrumb.innerHTML = ''; return; }
    const series = this.data.cadre_classement.series;
    const sd = series[seriesKey] || this.data.series_speciales[seriesKey.toLowerCase()];
    if (sd) {
      breadcrumb.innerHTML = `<span>AD13</span> / <span class="current">Série ${seriesKey} — ${sd.intitule}</span>`;
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const resp = await fetch('instruments_recherche_AD13.json');
    const data = await resp.json();
    new AD13Cartography(data);
  } catch (err) {
    console.error(err);
    document.body.insertAdjacentHTML('afterbegin',
      `<div style="padding:1rem;background:#fed7d7;color:#742a2a">Impossible de charger instruments_recherche_AD13.json (servir via HTTP). ${err.message}</div>`);
  }
});
