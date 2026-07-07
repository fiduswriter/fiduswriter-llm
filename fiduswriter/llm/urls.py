from django.urls import re_path

from . import views

urlpatterns = [
    re_path("^improve/$", views.improve, name="llm_improve"),
    re_path("^models/$", views.models, name="llm_models"),
    re_path("^preferences/$", views.preferences, name="llm_preferences"),
]
