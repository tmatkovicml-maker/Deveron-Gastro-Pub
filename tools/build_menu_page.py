#!/usr/bin/env python3
"""Builds jelovnik.html, a plain-HTML copy of the menu from menu.csv.

The main site renders the menu with JavaScript. Search engines and AI assistants
that do not run scripts read this page instead. Run it after changing menu.csv:
    python3 tools/build_menu_page.py
"""
import csv, html, json, re
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TABS = [('Specijaliteti', 'Specijaliteti', "Chef's specials"), ('Jelovnik', 'Jelovnik', 'Food menu'),
        ('Doručak', 'Doručak', 'Breakfast'), ('Deserti', 'Deserti', 'Desserts'),
        ('Pića', 'Pića', 'Drinks'), ('Vino', 'Vinska karta', 'Wine list')]
ALLERGENS = ['gluten / gluten', 'rakovi / crustaceans', 'jaja / eggs', 'riba / fish', 'kikiriki / peanuts',
             'soja / soy', 'mlijeko / milk', 'orašasti plodovi / tree nuts', 'celer / celery', 'gorušica / mustard',
             'sezam / sesame', 'sulfiti / sulphites', 'lupina / lupin', 'mekušci / molluscs']
HIDE = re.compile(r'^(ne|no|0|false)$', re.I)


def site_dict(src, name):
    m = re.search(r'const %s\s*=\s*(\{.*?\});\n' % name, src)
    return json.loads(m.group(1)) if m else {}


def price(v):
    v = v.strip()
    return v + ' €' if v and '€' not in v else v


def main():
    src = (ROOT / 'index.html').read_text(encoding='utf-8')
    cat_tr = {**site_dict(src, 'CAT_TR'), **site_dict(src, 'SEC_TR')}
    rows = list(csv.reader((ROOT / 'menu.csv').read_text(encoding='utf-8').splitlines()))
    head = [h.strip() for h in rows[0]]
    items = [dict(zip(head, (c.strip() for c in r))) for r in rows[1:]]
    items = [i for i in items if i.get('Naziv HR') and not HIDE.match(i.get('Prikaži', ''))]
    e = html.escape
    out = []
    for key, hr, en in TABS:
        group = [i for i in items if i['Kartica'] == key]
        if not group:
            continue
        out.append(f'<section><h2>{e(hr)} <span class="en">· {e(en)}</span></h2>')
        cats = list(dict.fromkeys(i['Kategorija'] for i in group))
        for cat in cats:
            if cat:
                cen = cat_tr.get(cat, {}).get('EN', '')
                hr_cat = cat_tr.get(cat, {}).get('HR', cat)
                out.append(f'<h3>{e(hr_cat)}' + (f' <span class="en">· {e(cen)}</span>' if cen and cen != hr_cat else '') + '</h3>')
            out.append('<ul>')
            for i in (x for x in group if x['Kategorija'] == cat):
                name, name_en = i['Naziv HR'], i.get('Naziv EN', '')
                desc = i.get('Opis HR', '')
                qty = i.get('Količina', '')
                al = [int(a) for a in re.findall(r'\d+', i.get('Alergeni', '')) if 1 <= int(a) <= 14]
                line = f'<li><div class="row"><span class="name">{e(name)}'
                line += f' <span class="qty">{e(qty)}</span>' if qty else ''
                line += f'</span><span class="price">{e(price(i.get("Cijena", "")))}</span></div>'
                if name_en and name_en.lower() != name.lower():
                    line += f'<div class="en">{e(name_en)}</div>'
                if desc and desc.lower() != name.lower():
                    line += f'<div class="desc">{e(desc)}</div>'
                if i.get('Vino uz jelo'):
                    line += f'<div class="desc">Vino uz jelo / wine pairing: {e(i["Vino uz jelo"])}</div>'
                if al:
                    line += '<div class="al">Alergeni / allergens: ' + ', '.join(f'{a} {ALLERGENS[a-1]}' for a in al) + '</div>'
                out.append(line + '</li>')
            out.append('</ul>')
        out.append('</section>')

    page = (ROOT / 'tools' / 'menu_template.html').read_text(encoding='utf-8')
    page = page.replace('{{MENU}}', '\n'.join(out)).replace('{{DATE}}', date.today().strftime('%d. %m. %Y.'))
    page = page.replace('{{COUNT}}', str(len(items)))
    (ROOT / 'jelovnik.html').write_text(page, encoding='utf-8')
    print(f'jelovnik.html: {len(items)} items')


if __name__ == '__main__':
    main()
