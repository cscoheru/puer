import json
v1 = [json.loads(l) for l in open('/opt/puer-hub/rag-data/eval/scores.v1.jsonl') if l.strip()]
v2 = [json.loads(l) for l in open('/opt/puer-hub/rag-data/eval/scores.v2.jsonl') if l.strip()]
v1_cy = {r['case_id']: r for r in v1 if r.get('category') == 'cross-year-reissue'}
v2_cy = {r['case_id']: r for r in v2 if r.get('category') == 'cross-year-reissue'}
hdr = '%-35s %-6s %-8s %-8s %-7s %-7s %-7s %-7s' % ('case_id','exp','v1_hit','v2_hit','v1_rk','v2_rk','v1_top','v2_top')
print(hdr)
all_ids = sorted(set(v1_cy) | set(v2_cy))
for cid in all_ids:
    a = v1_cy.get(cid, {}); b = v2_cy.get(cid, {})
    h1 = a.get('target_in_top5'); h2 = b.get('target_in_top5')
    h1s = 'PASS' if h1 else ('FAIL' if h1 is False else '-')
    h2s = 'PASS' if h2 else ('FAIL' if h2 is False else '-')
    r1 = a.get('target_dino_rank') or '-'
    r2 = b.get('target_dino_rank') or '-'
    t1 = (a.get('top1') or {}).get('skuId') or '-'
    t2 = (b.get('top1') or {}).get('skuId') or '-'
    exp = a.get('expected_sku') or b.get('expected_sku') or '-'
    flag = ''
    if h1s == 'PASS' and h2s == 'FAIL':
        flag = ' <<< REGRESSION'
    elif h1s == 'FAIL' and h2s == 'PASS':
        flag = ' <<< IMPROVED'
    elif t1 != t2:
        flag = ' (top1 路由变)'
    print('%s %s %s %s %s %s %s %s%s' % (cid.ljust(35), str(exp).ljust(6), h1s.ljust(8), h2s.ljust(8), str(r1).ljust(7), str(r2).ljust(7), str(t1).ljust(7), str(t2).ljust(7), flag))
