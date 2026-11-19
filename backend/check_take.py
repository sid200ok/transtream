#!/usr/bin/env python3
import os
import sys
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'transtream.settings')
sys.path.insert(0, '/home/ML/transtream/backend')

django.setup()

from studio.models import Take

take_id = '3d92ded8-97b4-48f6-bc1c-5877610d7eb3'
try:
    take = Take.objects.get(id=take_id)
    print(f'Found take: {take}')
    print(f'  id: {take.id}')
    print(f'  kind: {take.kind}')
    print(f'  source_filename: {take.source_filename}')
    print(f'  duration_ms: {take.duration_ms}')
    print(f'  language: {take.language}')
    print(f'  language_probability: {take.language_probability}')
    print(f'  language_hint: {take.language_hint}')
    print(f'  initial_prompt: {take.initial_prompt[:50] if take.initial_prompt else ""}')
    print(f'  raw_relpath: {take.raw_relpath}')
    print(f'  normalized_relpath: {take.normalized_relpath}')
    print(f'  created_at: {take.created_at}')
    segments = list(take.segments.filter(source='whisper').order_by('index'))
    print(f'  whisper segments: {len(segments)}')
    for s in segments:
        print(f'    [{s.index}] {s.start_ms}-{s.end_ms}ms speaker={s.speaker_id}: {s.text[:80]}')
except Take.DoesNotExist:
    print(f'Take {take_id} NOT FOUND')
    # List all takes
    for t in Take.objects.all()[:10]:
        print(f'  {t.id.hex[:8]}... kind={t.kind} lang={t.language} dur={t.duration_ms}ms')