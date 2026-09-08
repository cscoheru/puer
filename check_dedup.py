import json
v = json.load(open('/opt/puer-hub/rag-data/donghe-visual-ids.json'))
sku2row = v.get('skuId_to_row', {})
imgs = v.get('images', [])
# 找 2176 / 2177 的 image entry
for img in imgs:
    sks = img.get('skuIds') or [img.get('skuId')]
    if any(str(x) in ('2176','2177') for x in sks):
        print(json.dumps({k: img.get(k) for k in ('sha','skuIds','row','canonical')}, ensure_ascii=False))
