import unittest

from holocubic_cli_python.url import api_url, normalize_device_url


class NormalizeDeviceUrlTests(unittest.TestCase):
    def test_normalizes_supported_forms(self) -> None:
        self.assertEqual(
            normalize_device_url("192.0.2.42"), "http://192.0.2.42/devtools"
        )
        self.assertEqual(
            normalize_device_url("http://host/devtools/api/"), "http://host/devtools"
        )
        self.assertEqual(
            normalize_device_url("https://host:8443/devtools"),
            "https://host:8443/devtools",
        )

    def test_rejects_unsafe_forms(self) -> None:
        invalid = [
            "",
            "ftp://host",
            "http://user:pass@host",
            "http://host/other",
            "http://host?x=1",
        ]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_device_url(value)

    def test_api_url_encodes_unicode_query_values(self) -> None:
        url = api_url("http://host/devtools", "list", {"path": "/sd/空 格/#x%"})
        self.assertEqual(
            url,
            "http://host/devtools/api/list?path=%2Fsd%2F%E7%A9%BA+%E6%A0%BC%2F%23x%25",
        )
