"""
Privamon — Test Integration for Synthetic Test-Page Suite
Compatible with both pytest and unittest.
"""

import unittest
import subprocess
import sys
from pathlib import Path

class TestSyntheticSuite(unittest.TestCase):
    def test_synthetic_suite_integrity(self):
        repo_root = Path(__file__).resolve().parent.parent
        script_path = repo_root / "scripts" / "verify_test_suite.py"
        
        result = subprocess.run([sys.executable, str(script_path)], capture_output=True, text=True)
        self.assertEqual(
            result.returncode, 0,
            f"Synthetic suite verification failed:\n{result.stdout}\n{result.stderr}"
        )

if __name__ == "__main__":
    unittest.main()
