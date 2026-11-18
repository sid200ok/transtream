"""
TranStream Studio URL configuration (app-level, session-authenticated).

Pages:
  /studio/                              mic recording + upload UI
  /settings/  /account/  /about/
Upload + job polling (Phase 7):
  /studio/upload/                       POST multipart
  /studio/jobs/<uuid>/                  GET status
  /studio/jobs/<uuid>/transcript/       GET json|srt|vtt|txt
API key management (Phase 8, account page):
  /account/keys/                        GET list
  /account/keys/generate/               POST mint
  /account/keys/<uuid>/revoke/          POST revoke

The bearer-authenticated public API lives in studio.api_urls and is mounted
at /api/v1/ by transtream/urls.py — deliberately NOT here, so the two trust
models stay in separate files and neither can accidentally inherit the other's
authentication.
"""

from django.urls import path

from . import views

app_name = "studio"

urlpatterns = [
    # Pages
    path("studio/", views.studio, name="studio"),
    path("settings/", views.settings_page, name="settings"),
    path("account/", views.account, name="account"),
    path("about/", views.about, name="about"),

    # Upload ingest + job polling (session auth)
    path("studio/upload/", views.upload_view, name="upload"),
    path("studio/jobs/<uuid:job_id>/", views.upload_job_status, name="job_status"),
    path(
        "studio/jobs/<uuid:job_id>/transcript/",
        views.upload_job_transcript,
        name="job_transcript",
    ),

    # Public pages (no auth required)
    path("register/", views.register_view, name="register"),

    # Translation (Slice A / Task H)
    path("studio/translate/", views.translate_take_view, name="translate_take"),
    path("studio/translate/<uuid:take_id>/", views.get_translation_view, name="get_translation"),

    # Media Gallery (session auth) — UI overhaul
    path("studio/takes/", views.take_list, name="take_list"),
    path("studio/takes/<uuid:take_id>/transcript/", views.take_transcript, name="take_transcript"),
    path("studio/takes/<uuid:take_id>/script/", views.take_script_edit, name="take_script_edit"),
    path("studio/takes/<uuid:take_id>/script/list/", views.take_script_edits, name="take_script_edits"),

    # Voice cloning (session auth, Phase 7 / Phase 10)
    path("studio/voice-clone/", views.voice_clone, name="voice_clone"),
    path("studio/voice-clone/status/", views.voice_clone_status_view, name="voice_clone_status"),

    # API key management (session auth, account page)
    path("account/keys/", views.api_key_list, name="api_key_list"),
    path("account/keys/generate/", views.api_key_generate, name="api_key_generate"),
    path("account/keys/<uuid:key_id>/revoke/", views.api_key_revoke, name="api_key_revoke"),
]
