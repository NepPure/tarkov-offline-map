# -*- coding: utf-8 -*-
"""生成便携版启动图（构建期跑一次，产物 build/splash.bmp 会被打进 exe）。

素材：游戏客户端自带的启动器主视觉 launcher/Content/img/main_art.jpg（Battlestate Games 版权，
本项目与 BSG 无关、仅供离线自用；与地图/图标一样属于游戏素材）。
NSIS 便携包在解压内置数据时会用 BgImage 插件把它铺成背景 —— 这就是"双击后先看到一张图"。

用法: python tools/make-splash.py [--art <jpg>] [--out build/splash.bmp]
"""
import argparse, os, sys
from PIL import Image, ImageDraw, ImageFont, ImageEnhance

# NSIS 的 BgImage 是**按原尺寸**把图铺在解压窗口的左上角（实测 1000x750 会超出屏幕右下），
# 所以图本身要小：500x375 在 150% DPI 下约 750x560 物理像素，正常屏幕能完整看到。
W, H = 500, 375
FONT_BD = r'C:\Windows\Fonts\msyhbd.ttc'
FONT_RG = r'C:\Windows\Fonts\msyh.ttc'

def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--size', default='500x375')
    ap.add_argument('--art', default=None)
    ap.add_argument('--out', default=os.path.join('build', 'splash.bmp'))
    ap.add_argument('--preview', default=os.path.join('test-artifacts', 'splash-preview.png'))
    ap.add_argument('--inapp', default=os.path.join('renderer', 'splash.png'))
    a = ap.parse_args()
    global W, H
    W, H = (int(x) for x in a.size.lower().split('x'))
    k = W / 1000.0                 # 排版按 1000 宽设计，其它尺寸等比缩放
    px = lambda v: max(1, int(round(v * k)))

    # 1) 底图：没有现成的就用深色兜底，保证脚本永远能跑
    if a.art and os.path.exists(a.art):
        im = Image.open(a.art).convert('RGB')
    else:
        im = Image.new('RGB', (W, H), (14, 18, 24))
    # 按 cover 裁到目标比例
    sr, dr = im.width / im.height, W / H
    if sr > dr:
        nw = int(im.height * dr); im = im.crop(((im.width - nw) // 2, 0, (im.width - nw) // 2 + nw, im.height))
    else:
        nh = int(im.width / dr); im = im.crop((0, (im.height - nh) // 2, im.width, (im.height - nh) // 2 + nh))
    im = im.resize((W, H), Image.LANCZOS)
    im = ImageEnhance.Brightness(im).enhance(0.62)   # 压暗，白字才压得住

    # 2) 上下渐变压暗（图片本身很暗也要再加一层，保证文字区域干净）
    ov = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(ov)
    for y in range(H):
        t = y / H
        v = int(150 * max(0.0, (t - 0.35) / 0.65) ** 1.4) if t > 0.35 else 0
        v = max(v, int(90 * max(0.0, (0.18 - t) / 0.18) ** 1.4))
        d.line([(0, y), (W, y)], fill=min(220, v))
    im = Image.composite(Image.new('RGB', (W, H), (8, 10, 14)), im, ov)

    d = ImageDraw.Draw(im)
    # 3) 标题
    d.text((px(28), H - px(125)), '塔科夫地图', font=font(FONT_BD, px(38)), fill=(240, 245, 250))
    d.text((px(30), H - px(80)), '离线版 · 自动识图 · 截图定位 · 物价资料库', font=font(FONT_RG, px(14)), fill=(150, 200, 220))
    d.text((px(30), H - px(55)), '首次启动要解压内置数据（约 330 MB），请稍候…', font=font(FONT_RG, px(12)), fill=(251, 191, 36))
    d.line([(px(28), H - px(30)), (W - px(28), H - px(30))], fill=(60, 80, 100), width=1)
    d.text((px(30), H - px(23)), '与 Battlestate Games 无关 · 游戏素材版权归原公司所有', font=font(FONT_RG, px(9)), fill=(120, 132, 148))

    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    im.save(a.out, 'BMP')
    if a.inapp:
        os.makedirs(os.path.dirname(a.inapp) or '.', exist_ok=True)
        im.resize((im.width * 2, im.height * 2), Image.LANCZOS).save(a.inapp, 'PNG', optimize=True)
        print('INAPP %s %.0f KB' % (a.inapp, os.path.getsize(a.inapp) / 1024))
    if a.preview:
        os.makedirs(os.path.dirname(a.preview) or '.', exist_ok=True)
        im.save(a.preview, 'PNG')
    print('OUT %s %dx%d %.1f MB' % (a.out, im.width, im.height, os.path.getsize(a.out) / 1048576))

if __name__ == '__main__':
    main()