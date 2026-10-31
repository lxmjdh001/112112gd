#!/usr/bin/env python3
"""Start and stop this checkout's local API, admin site, and desktop client."""
import ctypes
import json
import os
from pathlib import Path
import signal
import secrets
import subprocess
import sys
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / '.runtime'
DATA = Path(os.environ.get('GONGDAN_LOCAL_DATA', str(Path.home() / '.local/share/gongdan007')))
PG = Path(os.environ.get('GONGDAN_PG_BIN', str(RUNTIME / 'postgres/bin')))
ENV = dict(os.environ, GONGDAN_LOCAL_DATA=str(DATA), GONGDAN_PG_BIN=str(PG),
           GONGDAN_API_URL='http://127.0.0.1:18080',
           GONGDAN_USER_DATA=str(RUNTIME / 'desktop-profile'))
node_bin = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin'
if (node_bin / 'node').is_file():
    ENV['PATH'] = str(node_bin) + os.pathsep + ENV.get('PATH', '')
RUNTIME.mkdir(exist_ok=True)


def running(name):
    try:
        record = json.loads((RUNTIME / (name + '.pid.json')).read_text())
        pid = record['pid']
        os.kill(pid, 0)
        started = subprocess.check_output(['ps', '-p', str(pid), '-o', 'lstart='], text=True).strip()
        return pid if started == record['started'] else None
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError):
        return None


def launch(name, args, cwd=ROOT):
    if running(name):
        return
    with (RUNTIME / (name + '.log')).open('ab') as log:
        child = subprocess.Popen(args, cwd=cwd, env=ENV, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    started = subprocess.check_output(['ps', '-p', str(child.pid), '-o', 'lstart='], text=True).strip()
    (RUNTIME / (name + '.pid.json')).write_text(json.dumps({'pid': child.pid, 'started': started}))
    print(f'{name}: started ({child.pid})', flush=True)


def ready(name, url):
    for _ in range(180):
        try:
            with urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        if not running(name):
            break
        time.sleep(0.5)
    raise SystemExit(f'{name} did not become ready; see {RUNTIME / (name + ".log")}')


def desktop():
    if not (ROOT / 'apps/desktop/dist/main.cjs').is_file():
        subprocess.run(['pnpm', 'build:desktop'], cwd=ROOT, env=ENV, check=True)
    launch('desktop', [str(ROOT / 'apps/desktop/node_modules/.bin/electron'), '.'], ROOT / 'apps/desktop')


def database():
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    config = DATA / 'development.env'
    if not config.exists():
        config.write_text('DATABASE_URL=postgres://127.0.0.1:55437/gongdan007?sslmode=disable\n'
                          'LISTEN_ADDR=127.0.0.1:18080\nBOOTSTRAP_USERNAME=admin\n'
                          f'BOOTSTRAP_PASSWORD={secrets.token_urlsafe(18)}\n'
                          f'GONGDAN_MASTER_KEY={secrets.token_hex(32)}\n')
        config.chmod(0o600)
    for line in config.read_text().splitlines():
        if line and not line.startswith('#'):
            key, value = line.split('=', 1)
            ENV[key] = value
    cluster = DATA / 'postgres'
    if not (cluster / 'PG_VERSION').exists():
        subprocess.run([str(PG / 'initdb'), '-D', str(cluster), '-A', 'trust',
                        '--no-locale', '--encoding=UTF8'], check=True)
    status = subprocess.run([str(PG / 'pg_ctl'), '-D', str(cluster), 'status'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if status.returncode:
        subprocess.run([str(PG / 'pg_ctl'), '-D', str(cluster), '-l', str(DATA / 'postgres.log'),
                        '-o', '-h 127.0.0.1 -p 55437', 'start'], check=True)
    # The standalone distribution includes libpq, without the psql/createdb tools.
    # Use its client API for the one-time database creation.
    pq = ctypes.CDLL(str(PG.parent / 'lib/libpq.5.dylib'))
    for name, args, result in [
        ('PQconnectdb', [ctypes.c_char_p], ctypes.c_void_p),
        ('PQstatus', [ctypes.c_void_p], ctypes.c_int),
        ('PQexec', [ctypes.c_void_p, ctypes.c_char_p], ctypes.c_void_p),
        ('PQresultStatus', [ctypes.c_void_p], ctypes.c_int),
        ('PQntuples', [ctypes.c_void_p], ctypes.c_int),
        ('PQerrorMessage', [ctypes.c_void_p], ctypes.c_char_p),
        ('PQclear', [ctypes.c_void_p], None),
        ('PQfinish', [ctypes.c_void_p], None),
    ]:
        fn = getattr(pq, name)
        fn.argtypes, fn.restype = args, result
    conn = pq.PQconnectdb(b'host=127.0.0.1 port=55437 dbname=postgres connect_timeout=5')
    try:
        if pq.PQstatus(conn) != 0:
            raise RuntimeError(pq.PQerrorMessage(conn).decode())
        result = pq.PQexec(conn, b"SELECT 1 FROM pg_database WHERE datname='gongdan007'")
        try:
            if pq.PQresultStatus(result) != 2:
                raise RuntimeError(pq.PQerrorMessage(conn).decode())
            exists = pq.PQntuples(result) > 0
        finally:
            pq.PQclear(result)
        if not exists:
            result = pq.PQexec(conn, b'CREATE DATABASE gongdan007')
            try:
                if pq.PQresultStatus(result) != 1:
                    raise RuntimeError(pq.PQerrorMessage(conn).decode())
            finally:
                pq.PQclear(result)
    finally:
        pq.PQfinish(conn)
    access = DATA / 'admin-access.txt'
    access.write_text('D1 Scrm 本机开发环境\n后台：http://127.0.0.1:5777\n'
                      f'账号：{ENV["BOOTSTRAP_USERNAME"]}\n密码：{ENV["BOOTSTRAP_PASSWORD"]}\n')
    access.chmod(0o600)


command = sys.argv[1] if len(sys.argv) > 1 else 'start'
if command == 'start':
    if not (PG / 'initdb').is_file():
        raise SystemExit(f'PostgreSQL binaries missing: {PG}; set GONGDAN_PG_BIN if installed elsewhere.')
    database()
    binary = RUNTIME / 'gongdan-api'
    sources = list((ROOT / 'server').rglob('*.go')) + [ROOT / 'server/go.mod', ROOT / 'server/go.sum']
    if not binary.is_file() or any(p.stat().st_mtime > binary.stat().st_mtime for p in sources):
        subprocess.run(['go', 'build', '-o', str(binary), './cmd/api'], cwd=ROOT / 'server', env=ENV, check=True)
    launch('api', [str(binary)])
    ready('api', 'http://127.0.0.1:18080/healthz')
    if not (ROOT / 'apps/admin/dist/index.html').is_file():
        subprocess.run(['pnpm', 'build:admin'], cwd=ROOT, env=ENV, check=True)
    launch('admin', ['pnpm', '--filter', '@gongdan/admin', 'exec', 'vite', 'preview',
                     '--host', '127.0.0.1', '--port', '5777', '--strictPort'])
    ready('admin', 'http://127.0.0.1:5777')
    desktop()
    print('Admin: http://127.0.0.1:5777\nAPI: http://127.0.0.1:18080')
    print(f'Credentials: {DATA / "admin-access.txt"}')
elif command == 'desktop':
    desktop()
elif command == 'status':
    for name in ('api', 'admin', 'desktop'):
        pid = running(name)
        print(f'{name}: ' + (f'running ({pid})' if pid else 'stopped'))
elif command == 'stop':
    for name in ('desktop', 'admin', 'api'):
        pid = running(name)
        if pid:
            os.killpg(pid, signal.SIGTERM)
            print(f'{name}: stopping')
    if (DATA / 'postgres/PG_VERSION').is_file():
        subprocess.run([str(PG / 'pg_ctl'), '-D', str(DATA / 'postgres'), '-m', 'fast', 'stop'], check=False)
else:
    raise SystemExit('Usage: python3 scripts/local.py start|desktop|status|stop')
