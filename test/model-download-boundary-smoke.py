"""Dependency-free checks for pinned first-use AI model downloads."""

import ast
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
BG_PATH = ROOT / 'python' / 'modules' / 'bg_remover.py'
DEMUCS_PATH = ROOT / 'python' / 'modules' / 'demucs_runner.py'


def assignment(tree, name):
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == name
                for target in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f'Missing assignment: {name}')


class ModelDownloadBoundaryTests(unittest.TestCase):
    def test_background_model_is_fully_pinned_and_cannot_fall_back(self):
        source = BG_PATH.read_text(encoding='utf-8')
        tree = ast.parse(source)
        digest = assignment(tree, '_MODEL_SHA256')
        size = assignment(tree, '_MODEL_SIZE')
        hosts = assignment(tree, '_MODEL_DOWNLOAD_HOSTS')

        self.assertRegex(digest, r'^[0-9a-f]{64}$')
        self.assertGreater(size, 100_000_000)
        self.assertEqual(hosts, {
            'github.com', 'release-assets.githubusercontent.com',
            'objects.githubusercontent.com',
        })
        self.assertIn('danielgatis/rembg/releases/download/v0.0.0', source)
        self.assertIn('class _RestrictedModelRedirects', source)
        self.assertIn('tempfile.NamedTemporaryFile', source)
        self.assertIn('hmac.compare_digest', source)
        self.assertIn('os.replace(temp_path, model_path)', source)
        self.assertIn('class _PinnedU2netSession', source)
        self.assertIn('return model_path', source)
        self.assertNotIn('new_session(', source)

        download = next(
            node for node in tree.body
            if isinstance(node, ast.ClassDef) and node.name == 'BGRemover'
            for node in node.body
            if isinstance(node, ast.FunctionDef) and node.name == '_download_model'
        )
        calls = [
            (node.lineno, ast.unparse(node.func))
            for node in ast.walk(download)
            if isinstance(node, ast.Call)
        ]
        offline_line = min(line for line, call in calls if call == '_offline_mode_enabled')
        opener_line = min(line for line, call in calls if call == 'urllib.request.build_opener')
        self.assertLess(offline_line, opener_line)

    def test_demucs_catalog_has_full_hashes_and_no_moving_remote_lookup(self):
        source = DEMUCS_PATH.read_text(encoding='utf-8')
        tree = ast.parse(source)
        models = assignment(tree, '_PINNED_MODELS')
        bags = assignment(tree, '_PINNED_BAGS')
        root = assignment(tree, '_MODEL_ROOT')

        self.assertEqual(root, 'https://dl.fbaipublicfiles.com/demucs/')
        self.assertEqual(len(models), 9)
        self.assertEqual(set(bags), {'htdemucs', 'htdemucs_ft', 'mdx_extra'})
        referenced = {signature for signatures in bags.values() for signature in signatures}
        self.assertEqual(referenced, set(models))
        for signature, (relative_url, size, digest) in models.items():
            self.assertRegex(signature, r'^[0-9a-f]{8}$')
            self.assertFalse(relative_url.startswith(('http:', 'https:')))
            self.assertGreater(size, 50_000_000)
            self.assertRegex(digest, r'^[0-9a-f]{64}$')

        self.assertLess(source.index('install_if_requested()'), source.index('import torch'))
        self.assertIn('class _RejectModelRedirects', source)
        self.assertIn('tempfile.NamedTemporaryFile', source)
        self.assertIn('hmac.compare_digest', source)
        self.assertIn('os.replace(temp_path, target)', source)
        self.assertIn('def _install_pinned_legacy_loader', source)
        self.assertNotRegex(source, re.compile(r'https://[^\s\'\"]*huggingface', re.I))

        main_guard = source.index("if __name__ == '__main__':")
        prepare = source.index('_prepare_pinned_model(sys.argv[1:])', main_guard)
        install = source.index('_install_pinned_legacy_loader()', main_guard)
        run = source.index('main(sys.argv[1:])', main_guard)
        self.assertLess(prepare, install)
        self.assertLess(install, run)


if __name__ == '__main__':
    unittest.main()
