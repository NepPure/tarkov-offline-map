# -*- coding: utf-8 -*-
"""攻略截图重编码（构建期用，不进应用）。

用法: python tools/lib/reencode.py <jobs.json> <width> <quality> <out.json>
jobs.json: [{name, url, src, dst}]   src = 已下载的原始文件（webp/png/jpg）
输出: [{name, w, h, bytes, source}]
"""
import json, os, sys
from PIL import Image

def main():
    jobs = json.load(open(sys.argv[1], encoding='utf-8'))
    width = int(sys.argv[2]); quality = int(sys.argv[3])
    out = []
    for j in jobs:
        src, dst = j['src'], j['dst']
        try:
            im = Image.open(src)
            if im.mode in ('RGBA', 'LA', 'P'):
                bg = Image.new('RGB', im.size, (18, 18, 18))
                im2 = im.convert('RGBA')
                bg.paste(im2, mask=im2.split()[-1])
                im = bg
            else:
                im = im.convert('RGB')
            w, h = im.size
            if w > width:
                im = im.resize((width, max(1, round(h * width / w))), Image.LANCZOS)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            im.save(dst, 'WEBP', quality=quality, method=6)
            out.append({'name': j['name'], 'w': im.width, 'h': im.height,
                        'bytes': os.path.getsize(dst), 'source': j.get('url')})
        except Exception as e:
            out.append({'name': j['name'], 'error': str(e)[:200], 'source': j.get('url')})
        if len(out) % 100 == 0:
            print('  [enc] %d/%d' % (len(out), len(jobs)), flush=True)
    json.dump(out, open(sys.argv[4], 'w', encoding='utf-8'), ensure_ascii=False)

if __name__ == '__main__':
    main()