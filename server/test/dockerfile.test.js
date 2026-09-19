'use strict';

/**
 * Dockerfile / docker-compose 的一致性检查。
 *
 * 本机没装 Docker 也能发现问题：镜像里"该有的文件在不在、有没有多带东西、
 * 健康检查命令能不能跑、compose 指的镜像标签对不对"这些都能静态查出来。
 * 之前踩过的坑就是这类：镜像里少一个被 require 的文件，容器起来就崩，而且只有推上去才知道。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(SERVER, p), 'utf-8');

/** 解析 Dockerfile 里从构建上下文 COPY 进来的文件（相对 server/） */
function copiedFromContext(dockerfile) {
  const out = new Set();
  for (const line of dockerfile.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.toUpperCase().startsWith('COPY ')) continue;
    const parts = s.split(/\s+/).slice(1);
    if (parts.some((p) => p.startsWith('--from='))) continue; // 多阶段构建的外部来源，不看
    if (parts.length < 2) continue;
    parts.pop(); // 最后一个是目标路径（./ /app 都行，不影响"源文件在不在"的判断）
    for (const src of parts) out.add(src.replace(/^\.\//, ''));
  }
  return out;
}

test('Dockerfile：运行时需要的文件都在 COPY 清单里（少一个容器就起不来）', () => {
  const dockerfile = read('Dockerfile');
  const copied = copiedFromContext(dockerfile);
  assert.ok(copied.has('package.json'), '必须 COPY package.json');
  assert.ok(copied.has('package-lock.json'), '必须 COPY package-lock.json（否则 npm ci 用不了）');
  assert.ok(copied.has('server.js') && copied.has('protocol.js'), '必须 COPY 两个源码文件');

  // server.js / protocol.js 里 require 的相对路径，必须都在 COPY 清单里
  for (const file of ['server.js', 'protocol.js']) {
    const src = read(file);
    const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      const rel = path.relative(SERVER, path.resolve(SERVER, path.dirname(file), m[1])).replace(/\\/g, '/');
      const candidates = [rel, `${rel}.js`, `${rel}.json`, `${rel}/index.js`];
      assert.ok(candidates.some((c) => copied.has(c)), `${file} require('${m[1]}') -> ${rel} 不在 Dockerfile 的 COPY 清单里`);
    }
  }
});

test('Dockerfile：非 root、端口、健康检查、启动命令、构建期不装 dev 依赖', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^FROM node:22-alpine/m, '基于 node:22-alpine（和 engines 要求一致）');
  assert.match(dockerfile, /^USER node$/m, '必须以非 root 用户跑（容器逃逸风险）');
  assert.match(dockerfile, /^EXPOSE 8787$/m);
  assert.match(dockerfile, /^CMD \["node", "server\.js"\]$/m);
  assert.match(dockerfile, /npm ci --omit=dev/, '构建时不能装 devDependencies（镜像要小）');
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*?\/healthz/, 'HEALTHCHECK 必须打 /healthz');
  assert.match(dockerfile, /^ENV[\s\S]*?PORT=8787/m, '默认端口 8787');
  // 健康检查那条命令本身要能跑（后面 image-sim 会真跑一次）
  const hc = dockerfile.match(/HEALTHCHECK[^\n]*\n\s*CMD (.*)/);
  assert.ok(hc && /process\.exit\(r\.ok\?0:1\)/.test(hc[1]), '健康检查要按 HTTP 状态返回 0/1');
});

test('.dockerignore：别把测试/源码仓库/落盘目录塞进镜像', () => {
  const ig = read('.dockerignore').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const need of ['node_modules', 'test', 'data']) {
    assert.ok(ig.includes(need), `.dockerignore 应该忽略 ${need}`);
  }
  // 该进的必须没被忽略
  for (const keep of ['server.js', 'protocol.js', 'package.json', 'package-lock.json']) {
    assert.ok(!ig.includes(keep) && !ig.includes(`*${keep}`), `${keep} 不能被 .dockerignore 忽略掉`);
  }
});

test('docker-compose：镜像标签与版本一致、端口与默认值合理', () => {
  const compose = read('docker-compose.yml');
  const pkg = JSON.parse(read('package.json'));
  const tag = `ghcr.io/neppure/tarkov-offline-map-server:${pkg.version}`;
  assert.ok(compose.includes(tag), `compose 里应该指向当前版本的镜像 ${tag}（改版本号时一起改，免得 compose 指着一个不存在的 tag）`);
  assert.match(compose, /"8787:8787"/, '默认映射 8787 端口');
  assert.match(compose, /restart: unless-stopped/);
  assert.match(compose, /PERSIST: "0"/, '默认纯内存（落盘是可选功能）');
  assert.match(compose, /MAX_ROOM_PEERS: "16"/);
});

test('CI 工作流：测试 -> 构建 -> 推 ghcr，且 PR 只构建不推', () => {
  const wf = path.join(SERVER, '..', '.github', 'workflows', 'server.yml');
  const yml = fs.readFileSync(wf, 'utf-8');
  assert.match(yml, /packages: write/, '推 ghcr 需要 packages: write');
  assert.match(yml, /working-directory: server[\s\S]*?npm test/, 'CI 里要跑服务端测试');
  assert.match(yml, /docker\/build-push-action/);
  assert.match(yml, /push: \$\{\{ github\.event_name != 'pull_request' \}\}/, 'PR 只构建不推');
  assert.match(yml, /context: server/, '构建上下文是 server/');
  assert.match(yml, /images: ghcr\.io\/neppure\/tarkov-offline-map-server/, '镜像名必须全小写（ghcr 不收大写）');
  assert.match(yml, /type=semver,pattern=\{\{version\}\}/, '打 tag 时用版本号做镜像标签');
  assert.match(yml, /value=latest/, '要有 latest 标签');
});
