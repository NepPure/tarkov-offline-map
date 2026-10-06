# -*- coding: utf-8 -*-
"""生成启动图（构建期跑一次）。

两条链路、两种"媒介"，尺寸规则不同 —— 这是这个脚本唯一容易搞错的地方：

1. build/splash.bmp —— NSIS 便携包解压时 BgImage 铺的那张。
   * 位图按**原生像素**画；NSIS 进程不是 DPI 感知的，所以 Windows 会把整张图按系统缩放比放大
     （150% 就是 1.5 倍）。实测：150% 屏上 500x375 的位图显示成约 811x587 逻辑像素。
   * 位图太大会被**裁掉**：实测 900x560 会顶到屏幕右下角外（所以这里固定用实测安全的 500x375）。
   * 结论：**别按位图宽度等比缩放文字**。位图本来就会被放大 ~1.5 倍，文字按"最终显示尺寸"给就行。

2. renderer/splash.png —— 应用内那张（Electron 窗口，本身 DPI 感知）。
   * 窗口 760x475 CSS 像素；图按它的 2 倍出（1520x950），显示时再缩一半，所以文字也要按 2 倍画。
   * 这样两个启动图在**最终观感上文字一样大**：位图里 44px 的字在 NSIS 那条路 ≈ 66 逻辑像素，
     应用内这条路的 44 CSS 像素 ≈ 同样量级。

用法:
  python tools/make-splash.py [--art <jpg>]
"""
import argparse, os
from PIL import Image, ImageDraw, ImageFont, ImageEnhance

FONT_BD = r'C:\Windows\Fonts\msyhbd.ttc'
FONT_RG = r'C:\Windows\Fonts\msyh.ttc'

# 版式基准：500x375 的画布上，文字用下面这套"最终显示尺寸"（单位与画布像素一致）
REF_W, REF_H = 500.0, 375.0
T_TITLE, T_SUB, T_HINT, T_FOOT = 44, 20, 18, 13


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def render(art_path, size, text_scale):
    W, H = size
    k = W / REF_W                      # 位置/留白按画布等比
    ts = text_scale                    # 文字另给一个系数（见文件头说明）
    px = lambda v: max(1, int(round(v * k)))
    tx = lambda v: max(1, int(round(v * ts)))

    if art_path and os.path.exists(art_path):
        im = Image.open(art_path).convert('RGB')
    else:
        im = Image.new('RGB', (W, H), (14, 18, 24))
    sr, dr = im.width / im.height, W / H
    if sr > dr:
        nw = int(im.height * dr)
        im = im.crop(((im.width - nw) // 2, 0, (im.width - nw) // 2 + nw, im.height))
    else:
        nh = int(im.width / dr)
        im = im.crop((0, (im.height - nh) // 2, im.width, (im.height - nh) // 2 + nh))
    im = im.resize((W, H), Image.LANCZOS)
    im = ImageEnhance.Brightness(im).enhance(0.62)

    ov = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(ov)
    for y in range(H):
        t = y / H
        v = int(150 * max(0.0, (t - 0.35) / 0.65) ** 1.4) if t > 0.35 else 0
        v = max(v, int(90 * max(0.0, (0.18 - t) / 0.18) ** 1.4))
        d.line([(0, y), (W, y)], fill=min(220, v))
    im = Image.composite(Image.new('RGB', (W, H), (8, 10, 14)), im, ov)

    d = ImageDraw.Draw(im)
    # 从下往上排，每块都留出间距 —— 顺序写错就会出现"文字叠在一起"
    m = px(16)                                        # 左边距
    y_foot = H - px(14) - tx(T_FOOT)                  # 版权行顶边
    y_sep = y_foot - px(12)                           # 分隔线
    y_hint = y_sep - px(10) - tx(T_HINT)              # 黄色提示行顶边
    y_sub = y_hint - px(6) - tx(T_SUB)                # 副标题顶边
    y_title = y_sub - px(6) - tx(T_TITLE)             # 大标题顶边
    d.text((m, y_title), '塔科夫地图', font=font(FONT_BD, tx(T_TITLE)), fill=(240, 245, 250))
    d.text((m, y_sub), '离线版 · 自动识图 · 截图定位 · 物价与物资资料库', font=font(FONT_RG, tx(T_SUB)), fill=(150, 200, 220))
    d.text((m, y_hint), '首次启动要解压内置数据（约 330 MB），请稍候…', font=font(FONT_RG, tx(T_HINT)), fill=(251, 191, 36))
    d.line([(m, y_sep), (W - m, y_sep)], fill=(60, 80, 100), width=max(1, px(1)))
    d.text((m, y_foot), '与 Battlestate Games 无关 · 游戏素材版权归原公司所有', font=font(FONT_RG, tx(T_FOOT)), fill=(120, 132, 148))
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--art', default=None)
    ap.add_argument('--nsis', default='500x375', help='NSIS 位图尺寸（实测 500x375 在 150% 屏上不越界；再大就会被裁）')
    ap.add_argument('--nsis-text', type=float, default=1.0)
    ap.add_argument('--inapp', default='1520x950', help='应用内图：窗口 CSS 尺寸的 2 倍')
    ap.add_argument('--inapp-text', type=float, default=2.0, help='显示时缩一半，所以文字按 2 倍画')
    ap.add_argument('--out', default=os.path.join('build', 'splash.bmp'))
    ap.add_argument('--inapp-out', default=os.path.join('renderer', 'splash.png'))
    ap.add_argument('--preview', default=os.path.join('test-artifacts', 'splash-preview.png'))
    a = ap.parse_args()
    parse = lambda s: tuple(int(x) for x in s.lower().split('x'))

    nsis = render(a.art, parse(a.nsis), a.nsis_text)
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    nsis.save(a.out, 'BMP')
    print('NSIS  %s %dx%d %.2f MB' % (a.out, nsis.width, nsis.height, os.path.getsize(a.out) / 1048576))

    inapp = render(a.art, parse(a.inapp), a.inapp_text)
    os.makedirs(os.path.dirname(a.inapp_out) or '.', exist_ok=True)
    inapp.save(a.inapp_out, 'PNG', optimize=True)
    print('INAPP %s %dx%d %.0f KB' % (a.inapp_out, inapp.width, inapp.height, os.path.getsize(a.inapp_out) / 1024))

    os.makedirs(os.path.dirname(a.preview) or '.', exist_ok=True)
    nsis.resize((nsis.width * 2, nsis.height * 2), Image.LANCZOS).save(a.preview, 'PNG')
    print('PREVIEW %s（NSIS 位图的 2 倍预览，约等于 150%% 屏上的观感）' % a.preview)


if __name__ == '__main__':
    main()
