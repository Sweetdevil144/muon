import app.service
from app import config


def run():
    return app.service.serve(config)
