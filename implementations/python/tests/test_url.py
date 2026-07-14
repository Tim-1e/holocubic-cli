import unittest

from holocubic_cli_python.url import normalize_device_url


class NormalizeDeviceUrlTests(unittest.TestCase):
    def test_normalizes_supported_forms(self) -> None:
        self.assertEqual(normalize_device_url("192.0.2.42"), "http://192.0.2.42/devtools")
        self.assertEqual(normalize_device_url("http://host/devtools/api/"), "http://host/devtools")
        self.assertEqual(normalize_device_url("https://host:8443/devtools"), "https://host:8443/devtools")

    def test_rejects_unsafe_forms(self) -> None:
        invalid = ["", "ftp://host", "http://user:pass@host", "http://host/other", "http://host?x=1"]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_device_url(value)
