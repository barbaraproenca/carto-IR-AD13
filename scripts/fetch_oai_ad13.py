#!/usr/bin/env python3
"""Récupère tous les instruments de recherche AD13 via OAI-PMH (oai_ead),
puis extrait les métadonnées de niveau fonds pour construire l'inventaire."""
import re, json, os, sys, time
import urllib.request, urllib.parse, ssl
from concurrent.futures import ThreadPoolExecutor, as_completed
import xml.etree.ElementTree as ET

BASE = "https://www.archives13.fr/ead/oai"
UA   = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
CTX  = ssl._create_unverified_context()

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60, context=CTX) as r:
                return r.read().decode("utf-8", errors="replace")
        except Exception as e:
            if attempt == 3:
                raise
            time.sleep(1 + attempt)

def list_identifiers():
    url = BASE + "?verb=ListIdentifiers&debug=1"
    xml = fetch(url)
    # Identifiers are in <identifier>...</identifier>
    return re.findall(r"<identifier>([^<]+)</identifier>", xml)

def parse_record(xml_text, oai_id):
    """Extract top-level metadata from the EAD."""
    # Strip XML namespace declarations to keep parsing simple
    try:
        # Wrap to ensure single root
        m = re.search(r"<metadata>(.*?)</metadata>", xml_text, re.DOTALL)
        if not m:
            return None
        ead_xml = m.group(1)
        # ElementTree with namespaces gets messy; do regex extraction.
        info = {"oai_identifier": oai_id}
        m1 = re.search(r"<eadid[^>]*>([^<]+)</eadid>", ead_xml)
        if m1: info["eadid"] = m1.group(1).strip()
        m1 = re.search(r"<titleproper[^>]*>(.*?)</titleproper>", ead_xml, re.DOTALL)
        if m1: info["titre"] = re.sub(r"<[^>]+>", " ", m1.group(1)).strip()
        m1 = re.search(r"<author[^>]*>(.*?)</author>", ead_xml, re.DOTALL)
        if m1: info["auteur"] = re.sub(r"<[^>]+>", " ", m1.group(1)).strip()
        m1 = re.search(r"<publicationstmt>.*?<date[^>]*>([^<]+)</date>", ead_xml, re.DOTALL)
        if m1: info["date_publication"] = m1.group(1).strip()
        # archdesc/did level info
        archdesc = re.search(r"<archdesc\b[^>]*>(.*?)</archdesc>", ead_xml, re.DOTALL)
        if archdesc:
            ad = archdesc.group(1)
            did = re.search(r"<did>(.*?)</did>", ad, re.DOTALL)
            if did:
                d = did.group(1)
                m1 = re.search(r"<unittitle[^>]*>(.*?)</unittitle>", d, re.DOTALL)
                if m1: info["unittitle"] = re.sub(r"<[^>]+>", " ", m1.group(1)).strip()
                m1 = re.search(r"<unitid[^>]*>(.*?)</unitid>", d, re.DOTALL)
                if m1: info["unitid"] = re.sub(r"<[^>]+>", " ", m1.group(1)).strip()
                m1 = re.search(r'<unitdate[^>]*>([^<]+)</unitdate>', d)
                if m1: info["unitdate"] = m1.group(1).strip()
                m1 = re.search(r'<unitdate[^>]*normal="([^"]+)"', d)
                if m1: info["unitdate_normal"] = m1.group(1).strip()
                m1 = re.search(r"<extent[^>]*>([^<]+)</extent>", d)
                if m1: info["extent"] = m1.group(1).strip()
                m1 = re.search(r"<origination[^>]*>(.*?)</origination>", d, re.DOTALL)
                if m1: info["origination"] = re.sub(r"<[^>]+>", " ", m1.group(1)).strip()
                m1 = re.search(r"<physloc[^>]*>([^<]+)</physloc>", d)
                if m1: info["physloc"] = m1.group(1).strip()
            m1 = re.search(r"<scopecontent[^>]*>(.*?)</scopecontent>", ad, re.DOTALL)
            if m1:
                txt = re.sub(r"<[^>]+>", " ", m1.group(1))
                info["scopecontent"] = re.sub(r"\s+", " ", txt).strip()[:500]
            m1 = re.search(r'<archdesc[^>]*\bid="([^"]+)"', ead_xml)
            if m1:
                info["ark"] = m1.group(1).replace("ark--", "ark:/").replace("-", "/", 1).replace("--", "/")
            # extract ARK from extptr
            m1 = re.search(r'<extptr[^>]*xlink:href="(https://www\.archives13\.fr/ark:/[^"]+)"', ead_xml)
            if m1: info["url"] = m1.group(1)
        return info
    except Exception as e:
        return {"oai_identifier": oai_id, "error": str(e)}

def get_record(oai_id):
    qs = urllib.parse.urlencode({
        "verb": "GetRecord",
        "metadataPrefix": "oai_ead",
        "identifier": oai_id,
    })
    return fetch(BASE + "?" + qs)

def classify(unitid):
    """Détermine la série du cadre de classement à partir d'une cote (ex: '2659 W', '6 J 12')."""
    if not unitid:
        return ""
    # Look for patterns: optional digits + space + letter(s) + optional digits
    # Examples: "2659 W", "6 J", "1 HD - 18 HD", "B", "1 T 2160"
    m = re.search(r"\b(\d+\s*[A-Z]+(?:\s*ETP)?)\b", unitid)
    if m:
        # Extract just the letters part
        letters = re.search(r"[A-Z]+(?:\s*ETP)?$", m.group(1).replace(" ", ""))
        # actually simpler:
    # Get the sequence of letters that forms the series code
    # Strategy: find the first uppercase letter run after optional digits
    parts = unitid.replace("-", " ").split()
    for p in parts:
        # capture the letters part
        m = re.match(r"^\d*([A-Z]+(?:ETP)?)", p.replace(" ",""))
        if m:
            code = m.group(1)
            # normalize: HD, ETP, Fi
            if code in ("HD","ETP","FI"):
                return code
            # only first letter for standard series
            if len(code) == 1:
                return code
            # multi-letter: keep first letter for E ETP, etc.
            if code.startswith("E") and "ETP" in p.upper():
                return "E_ETP"
            return code[0]
    return ""

def main():
    print("ListIdentifiers...", file=sys.stderr)
    ids = list_identifiers()
    print(f"  {len(ids)} identifiers", file=sys.stderr)

    results = []
    errors = 0
    done = 0

    def task(oai_id):
        try:
            xml = get_record(oai_id)
            return parse_record(xml, oai_id)
        except Exception as e:
            return {"oai_identifier": oai_id, "error": str(e)}

    with ThreadPoolExecutor(max_workers=16) as ex:
        futs = {ex.submit(task, i): i for i in ids}
        for f in as_completed(futs):
            r = f.result()
            done += 1
            if r is None or "error" in (r or {}):
                errors += 1
            else:
                results.append(r)
            if done % 50 == 0:
                print(f"  {done}/{len(ids)} (err={errors})", file=sys.stderr)

    print(f"Total: {len(results)} ok, {errors} errors", file=sys.stderr)

    # Add classification (série)
    for r in results:
        r["serie"] = classify(r.get("unitid", ""))

    out = {
        "metadata": {
            "source": "https://www.archives13.fr/ead/oai",
            "method": "OAI-PMH ListIdentifiers + GetRecord (oai_ead)",
            "total_collected": len(results),
            "total_listed": len(ids),
            "errors": errors,
        },
        "instruments": sorted(results, key=lambda r: (r.get("serie",""), r.get("unitid",""))),
    }
    with open("/tmp/ad13_full.json", "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    print("Wrote /tmp/ad13_full.json", file=sys.stderr)

if __name__ == "__main__":
    main()
