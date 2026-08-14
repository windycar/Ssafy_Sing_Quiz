/**
 * 방장이 고칠 파일 세 개를 `문제/` 폴더에 만들어 둡니다.
 *
 *   문제/곡목록.txt · 문제/속담.json · 문제/사자성어.json
 *
 * 없을 때만 만들고, 이미 있으면 **절대 건드리지 않습니다**. 행사 직전에 손본
 * 곡 목록을 실행할 때마다 기본값으로 덮어쓰는 것만큼 나쁜 동작은 없습니다.
 *
 * 런처가 서버를 켜기 직전에 한 번 실행합니다. 파일이 있어야 열어서 고칠 수
 * 있고, 이름을 문서에서 읽어 손으로 만들게 하면 오타가 납니다.
 *
 * 배치 파일이 아니라 여기서 만드는 이유: cmd.exe 는 배치 파일을 콘솔 코드
 * 페이지로 읽기 때문에 한글 파일 이름을 배치에 적으면 깨집니다. Node 는
 * UTF-8 을 그대로 다룹니다.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { EDITABLE_DIR, EDITABLE_FILES, PROJECT_ROOT } from '../server/localFiles.ts';
import type { LocalFileSpec } from '../server/localFiles.ts';

/** 만들거나(true) 이미 있어서 건너뛰거나(false). */
function ensure(spec: LocalFileSpec): boolean {
  // rootNames[0] 이 문서와 런처가 안내하는 위치입니다. 예전 위치에 파일이
  // 이미 있으면 그것도 "있는 것"으로 쳐서 새로 만들지 않습니다 — 그래야
  // 서버가 읽는 파일과 방장이 고치는 파일이 갈라지지 않습니다.
  for (const name of spec.rootNames) {
    if (existsSync(resolve(PROJECT_ROOT, name))) return false;
  }

  const target = resolve(PROJECT_ROOT, spec.rootNames[0] as string);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(PROJECT_ROOT, spec.bundled), target);
  return true;
}

const created: string[] = [];
for (const spec of EDITABLE_FILES) {
  if (ensure(spec)) created.push(spec.rootNames[0] as string);
}

if (created.length > 0) {
  console.log(`고칠 수 있는 파일을 ${EDITABLE_DIR} 폴더에 만들었습니다:`);
  for (const name of created) console.log(`  ${name}`);
  console.log('메모장으로 열어 고친 뒤 다시 실행하면 그대로 반영됩니다.\n');
}
