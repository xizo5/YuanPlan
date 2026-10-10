from urllib.parse import urlsplit, urlunsplit


def public_health_url(compose):
    """Resolve only the public app URL, never emit other Compose environment values."""
    value = compose['services']['app']['environment']['APP_URL']
    url = urlsplit(value)
    if (url.scheme != 'https' or not url.hostname or url.username is not None
            or url.password is not None or url.query or url.fragment):
        raise ValueError('APP_URL must be a public HTTPS URL without credentials, query or fragment')
    return urlunsplit((url.scheme, url.netloc, url.path.rstrip('/') + '/api/health', '', ''))


if __name__ == '__main__':
    import json
    import sys
    try:
        print(public_health_url(json.load(sys.stdin)))
    except (KeyError, TypeError, ValueError):
        print('Invalid public APP_URL in Compose configuration', file=sys.stderr)
        sys.exit(2)
