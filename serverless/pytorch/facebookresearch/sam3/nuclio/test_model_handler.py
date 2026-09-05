import hashlib
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from threading import Event, Lock
import numpy as np
import pytest
from PIL import Image
from types import ModuleType, SimpleNamespace
import sys

import model_handler
from model_handler import ModelHandler


class DummyPredictor:
    def __init__(self):
        self.received_image = None
        self.received_kwargs = None

    def set_image(self, image):
        self.received_image = image

    def predict(self, **kwargs):
        self.received_kwargs = kwargs
        masks = np.array(
            [
                [[0, 1], [0, 1]],
                [[1, 1], [0, 0]],
            ],
            dtype=np.uint8,
        )
        scores = np.array([0.1, 0.9], dtype=np.float32)
        low_res_masks = np.zeros((2, 256, 256), dtype=np.float32)
        return masks, scores, low_res_masks


class DummyTensor:
    def __init__(self, values):
        self.values = np.asarray(values)

    def detach(self):
        return self

    def cpu(self):
        return self

    def float(self):
        return DummyTensor(self.values.astype(np.float32))

    def numpy(self):
        return self.values


class DummyTextProcessor:
    def __init__(self, model=None, *, confidence_threshold=0.5):
        self.model = model
        self.confidence_threshold = confidence_threshold
        self.images = []
        self.states = []
        self.prompts = []
        self.geometric_prompts = []
        self.masks = np.empty((0, 1, 4, 5), dtype=bool)
        self.scores = np.empty((0,), dtype=np.float32)

    def set_image(self, image, state=None):
        self.images.append(image)
        if state is None:
            state = {}
        self.states.append(state)
        state.update({
            'original_height': image.height,
            'original_width': image.width,
            'backbone_out': {},
        })
        return state

    def set_text_prompt(self, *, prompt, state):
        self.prompts.append(prompt)
        assert state is self.states[-1]
        return self._set_output(state)

    def add_geometric_prompt(self, *, box, label, state):
        self.geometric_prompts.append({
            'box': box,
            'label': label,
            'state': state,
        })
        assert state is self.states[-1]
        return self._set_output(state)

    def _set_output(self, state):
        state.update({
            'geometric_prompt': object(),
            'masks': DummyTensor(self.masks),
            'masks_logits': DummyTensor(self.masks.astype(np.float32)),
            'boxes': DummyTensor(np.zeros((len(self.masks), 4), dtype=np.float32)),
            'scores': DummyTensor(self.scores),
        })
        return state


def install_text_processor(monkeypatch):
    processor_module = ModuleType('sam3.model.sam3_image_processor')
    processor_module.Sam3Processor = DummyTextProcessor
    monkeypatch.setitem(sys.modules, 'sam3.model.sam3_image_processor', processor_module)


def decode_mask(points, image_size):
    left, top, right, bottom = points[-4:]
    counts = points[:-4]
    pixels = np.repeat(np.arange(len(counts)) % 2, counts)
    mask = np.zeros((image_size[1], image_size[0]), dtype=bool)
    mask[top:bottom + 1, left:right + 1] = pixels.reshape(
        bottom - top + 1, right - left + 1,
    )
    return mask


def make_handler():
    handler = ModelHandler.__new__(ModelHandler)
    handler._inference_lock = Lock()
    handler._autocast = nullcontext
    handler.predictor = DummyPredictor()
    handler.processor = DummyTextProcessor()
    return handler


@pytest.fixture
def local_checkpoint(monkeypatch, tmp_path):
    payload = b'checkpoint'
    checkpoint = tmp_path / 'sam3.pt'
    checkpoint.write_bytes(payload)
    monkeypatch.setenv('SAM3_CHECKPOINT_PATH', str(checkpoint))
    monkeypatch.setattr(model_handler, 'EXPECTED_CHECKPOINT_SIZE', len(payload))
    monkeypatch.setattr(
        model_handler,
        'EXPECTED_CHECKPOINT_SHA256',
        hashlib.sha256(payload).hexdigest(),
    )
    return checkpoint


def test_checkpoint_contract_uses_approved_artifact_literals():
    assert model_handler.EXPECTED_CHECKPOINT_SIZE == 3_450_062_241
    assert model_handler.EXPECTED_CHECKPOINT_SHA256 == (
        '9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e'
    )


def test_handle_selects_highest_scoring_mask_and_normalizes_prompts():
    handler = make_handler()
    image = Image.new('RGB', (2, 2), 'black')

    mask = handler.handle(
        image,
        pos_points=[[10.0, 20.0]],
        neg_points=[[30.0, 40.0]],
        obj_bbox=[[1.0, 2.0], [3.0, 4.0]],
    )

    assert mask == [[1, 1], [0, 0]]
    assert handler.predictor.received_image.tolist() == [
        [[0, 0, 0], [0, 0, 0]],
        [[0, 0, 0], [0, 0, 0]],
    ]
    assert handler.predictor.received_kwargs['point_coords'].tolist() == [[10.0, 20.0], [30.0, 40.0]]
    assert handler.predictor.received_kwargs['point_labels'].tolist() == [1, 0]
    assert handler.predictor.received_kwargs['box'].tolist() == [1.0, 2.0, 3.0, 4.0]
    assert handler.predictor.received_kwargs['multimask_output'] is True
    assert handler.predictor.received_kwargs['return_logits'] is False


def test_handle_requires_at_least_one_prompt():
    handler = make_handler()
    image = Image.new('RGB', (2, 2), 'black')

    with pytest.raises(ValueError, match='at least one point or a bounding box'):
        handler.handle(image, pos_points=[], neg_points=[], obj_bbox=None)


def test_text_returns_distinct_instances_with_tight_row_major_rle_and_confidence():
    handler = make_handler()
    image = Image.new('RGB', (5, 4), 'black')
    handler.processor.masks = np.array([
        [[[0, 0, 0, 0, 0], [0, 1, 1, 0, 0], [0, 1, 0, 0, 0], [0, 0, 0, 0, 0]]],
        [[[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 1], [0, 0, 0, 1, 1]]],
    ], dtype=bool)
    handler.processor.scores = np.array([0.875, 0.625], dtype=np.float32)

    shapes = handler.handle_text(image, text_prompt='  red objects  ')

    assert shapes == [
        {
            'type': 'mask',
            'points': [0, 3, 1, 1, 1, 2, 2],
            'attributes': [{'spec_id': 0, 'value': '0.875'}],
        },
        {
            'type': 'mask',
            'points': [1, 3, 3, 2, 4, 3],
            'attributes': [{'spec_id': 0, 'value': '0.625'}],
        },
    ]
    for shape, expected_mask in zip(shapes, handler.processor.masks[:, 0]):
        np.testing.assert_array_equal(decode_mask(shape['points'], image.size), expected_mask)
    assert handler.processor.images == [image]
    assert handler.processor.prompts == ['red objects']
    assert handler.predictor.received_image is None


def test_text_returns_no_shapes_when_no_instances_match():
    handler = make_handler()

    assert handler.handle_text(Image.new('RGB', (5, 4)), text_prompt='cat') == []


@pytest.mark.parametrize('match_count', [0, 1])
def test_text_accepts_native_bfloat16_confidence_scores(match_count):
    torch = pytest.importorskip('torch')

    class NativeTensorProcessor(DummyTextProcessor):
        def set_text_prompt(self, *, prompt, state):
            output = super().set_text_prompt(prompt=prompt, state=state)
            output['masks'] = torch.from_numpy(self.masks)
            output['scores'] = torch.as_tensor(self.scores, dtype=torch.bfloat16)
            return output

    handler = make_handler()
    handler.processor = NativeTensorProcessor()
    handler.processor.masks = np.ones((match_count, 1, 4, 5), dtype=bool)
    handler.processor.scores = np.full((match_count,), 0.625, dtype=np.float32)

    shapes = handler.handle_text(Image.new('RGB', (5, 4)), text_prompt='cat')

    assert len(shapes) == match_count
    if match_count:
        assert shapes == [{
            'type': 'mask',
            'points': [0, 20, 0, 0, 4, 3],
            'attributes': [{'spec_id': 0, 'value': '0.625'}],
        }]


def test_text_skips_empty_masks_without_mixing_up_scores():
    handler = make_handler()
    handler.processor.masks = np.zeros((2, 1, 4, 5), dtype=bool)
    handler.processor.masks[1, 0, 3, 4] = True
    handler.processor.scores = np.array([0.875, 0.625], dtype=np.float32)

    assert handler.handle_text(Image.new('RGB', (5, 4)), text_prompt='cat') == [{
        'type': 'mask',
        'points': [0, 1, 4, 3, 4, 3],
        'attributes': [{'spec_id': 0, 'value': '0.625'}],
    }]


def test_text_starts_with_fresh_image_state_for_every_request():
    handler = make_handler()

    handler.handle_text(Image.new('RGB', (5, 4)), text_prompt='cat')
    first_state = handler.processor.states[0]
    first_state['previous_request'] = True
    handler.handle_text(Image.new('RGB', (3, 2)), text_prompt='dog')
    second_state = handler.processor.states[1]

    assert second_state is not first_state
    assert 'previous_request' not in second_state
    assert second_state['original_width'] == 3
    assert second_state['original_height'] == 2
    assert all(value is not first_state and value is not second_state for value in vars(handler).values())


@pytest.mark.parametrize('exemplar_bbox', [None, []])
def test_concept_text_only_matches_text_path_and_does_not_add_a_box(exemplar_bbox):
    image = Image.new('RGB', (5, 4), 'black')
    masks = np.zeros((2, 1, 4, 5), dtype=bool)
    masks[0, 0, 1, 1:3] = True
    masks[1, 0, 3, 4] = True
    scores = np.array([0.875, 0.625], dtype=np.float32)
    text_handler = make_handler()
    concept_handler = make_handler()
    for handler in (text_handler, concept_handler):
        handler.processor.masks = masks.copy()
        handler.processor.scores = scores.copy()

    expected = text_handler.handle_text(image, text_prompt='  surface joint  ')
    actual = concept_handler.handle_concept(
        image, text_prompt='  surface joint  ', exemplar_bbox=exemplar_bbox,
    )

    assert actual == expected
    assert concept_handler.processor.prompts == ['surface joint']
    assert concept_handler.processor.geometric_prompts == []


def test_concept_box_only_uses_positive_public_geometric_prompt_and_all_outputs():
    handler = make_handler()
    image = Image.new('RGB', (200, 100), 'black')
    handler.processor.masks = np.zeros((3, 1, 100, 200), dtype=bool)
    handler.processor.masks[0, 0, 1, 1] = True
    handler.processor.masks[1, 0, 3, 4:6] = True
    handler.processor.masks[2, 0, 8:10, 10] = True
    handler.processor.scores = np.array([0.9, 0.7, 0.4], dtype=np.float32)

    shapes = handler.handle_concept(
        image, text_prompt=None, exemplar_bbox=[20, 10, 120, 70],
    )

    assert handler.processor.prompts == []
    assert len(handler.processor.geometric_prompts) == 1
    prompt = handler.processor.geometric_prompts[0]
    assert prompt['label'] is True
    assert prompt['state'] is handler.processor.states[0]
    np.testing.assert_allclose(prompt['box'], [0.35, 0.4, 0.5, 0.6])
    assert [shape['attributes'][0]['value'] for shape in shapes] == [
        str(float(score)) for score in handler.processor.scores
    ]
    for shape, expected_mask in zip(shapes, handler.processor.masks[:, 0]):
        np.testing.assert_array_equal(decode_mask(shape['points'], image.size), expected_mask)


def test_concept_combines_text_and_box_on_the_same_fresh_state():
    handler = make_handler()
    image = Image.new('RGB', (20, 10), 'black')
    handler.processor.masks = np.ones((1, 1, 10, 20), dtype=bool)
    handler.processor.scores = np.array([0.75], dtype=np.float32)

    handler.handle_concept(
        image, text_prompt='  concrete surface ', exemplar_bbox=[2, 1, 12, 7],
    )

    assert handler.processor.prompts == ['concrete surface']
    assert len(handler.processor.states) == 1
    assert handler.processor.geometric_prompts == [{
        'box': [0.35, 0.4, 0.5, 0.6],
        'label': True,
        'state': handler.processor.states[0],
    }]


def test_concept_clamps_exemplar_box_to_current_image_before_normalizing():
    handler = make_handler()

    handler.handle_concept(
        Image.new('RGB', (200, 100)),
        exemplar_bbox=[-20, 10, 250, 120],
    )

    assert handler.processor.geometric_prompts[0]['box'] == [0.5, 0.55, 1.0, 0.9]


@pytest.mark.parametrize(('text_prompt', 'exemplar_bbox'), [
    (None, None),
    ('', None),
    ('   ', None),
    ('   ', []),
])
def test_concept_requires_text_or_an_exemplar_box(text_prompt, exemplar_bbox):
    handler = make_handler()

    with pytest.raises(ValueError, match='text prompt or an exemplar bounding box'):
        handler.handle_concept(
            Image.new('RGB', (20, 10)),
            text_prompt=text_prompt,
            exemplar_bbox=exemplar_bbox,
        )

    assert handler.processor.images == []


@pytest.mark.parametrize('exemplar_bbox', [
    [1, 2, 3],
    [1, 2, 3, 4, 5],
    '1,2,3,4',
    {},
    np.array([1, 2, 3, 4]),
    [True, 1, 3, 4],
    [1, '2', 3, 4],
    [1, 2, float('nan'), 4],
    [1, 2, 3, float('inf')],
    [1, 2, 2**10000, 4],
    [-2**10000, 2, 3, 4],
    [4, 2, 4, 8],
    [6, 2, 4, 8],
    [-10, 2, -1, 8],
    [1, 20, 5, 30],
])
def test_concept_rejects_malformed_or_degenerate_exemplar_boxes(exemplar_bbox):
    handler = make_handler()

    with pytest.raises(ValueError, match='[Ee]xemplar bounding box'):
        handler.handle_concept(
            Image.new('RGB', (20, 10)),
            text_prompt='surface',
            exemplar_bbox=exemplar_bbox,
        )

    assert handler.processor.images == []
    assert handler.processor.prompts == []
    assert handler.processor.geometric_prompts == []


def test_init_reuses_image_backbone_for_interactive_predictor_when_missing(
    monkeypatch,
    local_checkpoint,
):
    fake_predictor_model = SimpleNamespace(backbone=None)
    fake_predictor = SimpleNamespace(model=fake_predictor_model)
    fake_model = SimpleNamespace(
        backbone='shared-backbone',
        inst_interactive_predictor=fake_predictor,
    )

    fake_builder_module = ModuleType('sam3.model_builder')
    fake_builder_module.build_sam3_image_model = lambda **kwargs: fake_model

    fake_sam3_package = ModuleType('sam3')
    fake_sam3_package.model_builder = fake_builder_module

    fake_torch_module = SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: True),
        autocast=lambda **kwargs: nullcontext(), bfloat16='bfloat16',
    )

    monkeypatch.setitem(sys.modules, 'sam3', fake_sam3_package)
    monkeypatch.setitem(sys.modules, 'sam3.model_builder', fake_builder_module)
    monkeypatch.setitem(sys.modules, 'torch', fake_torch_module)
    install_text_processor(monkeypatch)

    handler = ModelHandler()

    assert handler.predictor is fake_predictor
    assert fake_predictor.model.backbone == 'shared-backbone'
    assert handler.model is fake_model
    assert handler.processor.model is fake_model
    assert handler.processor.confidence_threshold == 0.2


def test_init_requires_local_checkpoint_path(monkeypatch):
    monkeypatch.delenv('SAM3_CHECKPOINT_PATH', raising=False)

    with pytest.raises(RuntimeError, match='SAM3_CHECKPOINT_PATH is required'):
        ModelHandler()


def test_init_rejects_missing_local_checkpoint(monkeypatch, tmp_path):
    missing = tmp_path / 'missing.pt'
    monkeypatch.setenv('SAM3_CHECKPOINT_PATH', str(missing))

    with pytest.raises(RuntimeError, match='checkpoint file does not exist'):
        ModelHandler()


def test_init_rejects_checkpoint_size_mismatch(local_checkpoint):
    local_checkpoint.write_bytes(b'too-small')

    with pytest.raises(RuntimeError, match='size mismatch'):
        ModelHandler()


def test_init_rejects_same_size_checkpoint_hash_mismatch(local_checkpoint):
    local_checkpoint.write_bytes(b'checkpoinx')

    with pytest.raises(RuntimeError, match='SHA-256 mismatch'):
        ModelHandler()


def test_init_rejects_checkpoint_symlink(local_checkpoint):
    target = local_checkpoint.with_name('target.pt')
    target.write_bytes(local_checkpoint.read_bytes())
    local_checkpoint.unlink()
    local_checkpoint.symlink_to(target)

    with pytest.raises(RuntimeError, match='not a regular file'):
        ModelHandler()


def test_init_passes_local_checkpoint_to_native_builder(monkeypatch, local_checkpoint):
    calls = []
    fake_predictor_model = SimpleNamespace(backbone='shared-backbone')
    fake_predictor = SimpleNamespace(model=fake_predictor_model)
    fake_model = SimpleNamespace(
        backbone='shared-backbone',
        inst_interactive_predictor=fake_predictor,
    )

    fake_builder_module = ModuleType('sam3.model_builder')
    fake_builder_module.build_sam3_image_model = (
        lambda **kwargs: calls.append(kwargs) or fake_model
    )

    fake_sam3_package = ModuleType('sam3')
    fake_sam3_package.model_builder = fake_builder_module

    fake_torch_module = SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: True),
        autocast=lambda **kwargs: nullcontext(), bfloat16='bfloat16',
    )

    monkeypatch.setitem(sys.modules, 'sam3', fake_sam3_package)
    monkeypatch.setitem(sys.modules, 'sam3.model_builder', fake_builder_module)
    monkeypatch.setitem(sys.modules, 'torch', fake_torch_module)
    install_text_processor(monkeypatch)
    ModelHandler()

    assert calls == [{
        'device': 'cuda',
        'checkpoint_path': str(local_checkpoint),
        'load_from_HF': False,
        'enable_inst_interactivity': True,
    }]


class RefinementPredictor(DummyPredictor):
    def __init__(self, mask_input_size=(12, 16)):
        super().__init__()
        self.model = SimpleNamespace(sam_prompt_encoder=SimpleNamespace(
            mask_input_size=mask_input_size,
        ))
        self.mask = np.zeros((4, 6), dtype=bool)
        self.mask[1:3, 3:5] = True
        self.requests = []

    def predict(self, **kwargs):
        self.received_kwargs = kwargs
        self.requests.append((self.received_image.copy(), kwargs))
        mask = np.zeros(self.received_image.shape[:2], dtype=bool)
        mask[:self.mask.shape[0], :self.mask.shape[1]] = self.mask
        return mask[None], np.array([0.75]), np.empty((1, 12, 16))


def make_refinement_handler(mask_input_size=(12, 16)):
    handler = make_handler()
    handler.predictor = RefinementPredictor(mask_input_size)
    return handler


def test_refine_uses_image_sized_seed_signed_float_logits_and_all_points():
    torch = pytest.importorskip('torch')
    handler = make_refinement_handler((4, 6))
    image = Image.new('RGB', (6, 4), 'black')
    # Offset 2x2 seed with a hole; expands to the complete nonsquare image first.
    seed = [0, 1, 1, 2, 3, 1, 4, 2]

    shapes = handler.handle_refine(
        image, refinement_mask=seed,
        pos_points=[[1.5, 2], [4, 1]], neg_points=[[2, 3]],
    )

    kwargs = handler.predictor.requests[0][1]
    assert kwargs['multimask_output'] is False
    assert kwargs['return_logits'] is False
    assert kwargs['box'].dtype == np.float32
    # Preserve the selected object's extent, including the positive point to its left.
    # The negative point below the seed must not enlarge the object box.
    np.testing.assert_array_equal(kwargs['box'], [1.5, 1, 5, 3])
    assert kwargs['point_coords'].dtype == np.float32
    assert kwargs['point_coords'].tolist() == [[1.5, 2], [4, 1], [2, 3]]
    assert kwargs['point_labels'].dtype == np.int32
    assert kwargs['point_labels'].tolist() == [1, 1, 0]
    logits = torch.as_tensor(kwargs['mask_input'])
    assert logits.dtype == torch.float32
    assert logits.shape == (1, 4, 6)
    assert torch.isfinite(logits).all()
    # Keep the binary seed a soft prior: strong logits suppressed real negative clicks.
    assert float(logits.abs().max()) <= 1.0
    expected_seed = decode_mask(seed, image.size)
    np.testing.assert_array_equal(logits[0].numpy() > 0, expected_seed)
    assert bool((logits[0][~torch.from_numpy(expected_seed)] < 0).all())
    assert handler.predictor.received_image.shape == (4, 6, 3)
    assert len(shapes) == 1
    assert shapes[0]['type'] == 'mask'
    assert 'label' not in shapes[0]
    assert shapes[0]['attributes'] == []
    assert shapes[0]['points'] == [0, 4, 3, 1, 4, 2]
    np.testing.assert_array_equal(decode_mask(shapes[0]['points'], image.size), handler.predictor.mask)


@pytest.mark.parametrize(('positives', 'negatives', 'expected_box'), [
    ([[4, 1]], [], [3, 1, 5, 3]),
    ([[0, 0], [5.5, 3.5]], [], [0, 0, 5.5, 3.5]),
    ([], [[0, 0], [5, 3]], [3, 1, 5, 3]),
])
def test_refine_anchors_seed_extent_and_expands_only_for_positive_points(
    positives, negatives, expected_box,
):
    pytest.importorskip('torch')
    handler = make_refinement_handler()
    handler.handle_refine(
        Image.new('RGB', (6, 4)), refinement_mask=[0, 4, 3, 1, 4, 2],
        pos_points=positives, neg_points=negatives,
    )
    np.testing.assert_array_equal(handler.predictor.requests[0][1]['box'], expected_box)


def test_refine_single_pixel_seed_has_nonempty_box_at_image_edge():
    pytest.importorskip('torch')
    handler = make_refinement_handler()
    handler.handle_refine(
        Image.new('RGB', (6, 4)), refinement_mask=[0, 1, 5, 3, 5, 3],
        pos_points=[[5, 3]], neg_points=[],
    )
    np.testing.assert_array_equal(handler.predictor.requests[0][1]['box'], [5, 3, 6, 4])


@pytest.mark.parametrize('mask_input_size', [(288, 288), (8, 12)])
def test_refine_resizes_logits_to_actual_prompt_encoder_resolution(mask_input_size):
    torch = pytest.importorskip('torch')
    handler = make_refinement_handler(mask_input_size)
    handler.handle_refine(
        Image.new('RGB', (6, 4)), refinement_mask=[0, 4, 3, 1, 4, 2],
        pos_points=[], neg_points=[[0, 0]],
    )
    logits = torch.as_tensor(handler.predictor.received_kwargs['mask_input'])
    assert logits.shape == (1, *mask_input_size)
    assert logits.dtype == torch.float32
    assert torch.isfinite(logits).all()
    assert logits.min() < 0 < logits.max()


@pytest.mark.parametrize('seed', [
    None, {}, 'mask', [], [1, 0, 0, 0],
    [0, True, 0, 0, 0, 0], [0, 1.0, 0, 0, 0, 0],
    [0, 1, False, 0, 0, 0], [0, 1, 0, 0, 0.0, 0],
    [-1, 2, 0, 0, 0, 0], [0, 3, 1, 1, 2, 2],
    [0, 5, 1, 1, 2, 2], [4, 0, 1, 1, 2, 2],
    [0, 1, -1, 0, -1, 0], [0, 1, 6, 0, 6, 0],
    [0, 1, 0, 4, 0, 4], [0, 1, 2, 1, 1, 1],
    [0, 1, 1, 2, 1, 1], [0, 2**100, 0, 0, 0, 0],
])
def test_refine_rejects_invalid_rle_before_predictor_use(seed):
    handler = make_refinement_handler()
    with pytest.raises(ValueError, match='[Mm]ask'):
        handler.handle_refine(
            Image.new('RGB', (6, 4)), refinement_mask=seed,
            pos_points=[[1, 1]], neg_points=[],
        )
    assert handler.predictor.received_image is None
    assert handler.predictor.requests == []


@pytest.mark.parametrize('pos_points, neg_points', [
    ([], []), (None, [[1, 1]]), ([[1, 1]], None),
    ([1, 1], []), ([[1]], []), ([[1, 1, 1]], []),
    ([[True, 1]], []), ([['1', 1]], []), ([[float('nan'), 1]], []),
    ([], [[1, float('inf')]]), ([[6, 1]], []), ([], [[1, 4]]),
    ([[-1, 0]], []), ([[2**1000, 0]], []), ({}, [[1, 1]]),
])
def test_refine_rejects_invalid_points_before_predictor_use(pos_points, neg_points):
    handler = make_refinement_handler()
    with pytest.raises(ValueError, match='point'):
        handler.handle_refine(
            Image.new('RGB', (6, 4)), refinement_mask=[0, 4, 3, 1, 4, 2],
            pos_points=pos_points, neg_points=neg_points,
        )
    assert handler.predictor.received_image is None


def test_refine_returns_empty_shapes_for_empty_prediction():
    handler = make_refinement_handler()
    handler.predictor.mask[:] = False
    assert handler.handle_refine(
        Image.new('RGB', (6, 4)), refinement_mask=[0, 4, 3, 1, 4, 2],
        pos_points=[[3, 1]], neg_points=[],
    ) == []


def test_refine_replays_fixed_seed_after_different_image_and_point_removal():
    handler = make_refinement_handler()
    first_image = Image.new('RGB', (6, 4), 'black')
    second_image = Image.new('RGB', (8, 5), 'white')
    seed = [0, 4, 3, 1, 4, 2]
    calls = [
        (first_image, seed, [[3, 1]], []),
        (first_image, seed, [[3, 1]], [[0, 0]]),
        (second_image, [0, 1, 6, 4, 6, 4], [[6, 4]], []),
        (first_image, seed, [[3, 1]], []),
    ]
    for image, refinement_mask, pos_points, neg_points in calls:
        handler.handle_refine(image, refinement_mask=refinement_mask,
                              pos_points=pos_points, neg_points=neg_points)
    first, expanded, other, replay = [
        request for request in handler.predictor.requests if request[1]['box'] is not None
    ]
    np.testing.assert_array_equal(first[0], replay[0])
    for name in ('mask_input', 'point_coords', 'point_labels'):
        np.testing.assert_array_equal(first[1][name], replay[1][name])
    np.testing.assert_array_equal(first[1]['mask_input'], expanded[1]['mask_input'])
    assert other[0].shape == (5, 8, 3)
    assert seed == [0, 4, 3, 1, 4, 2]


def test_concurrent_visual_and_refinement_cannot_replace_each_others_image():
    handler = make_refinement_handler()
    first_image_set = Event()
    allow_first_prediction = Event()
    second_lock_attempted = Event()

    class ObservedLock:
        def __init__(self):
            self.lock = Lock()
            self.attempts = 0

        def __enter__(self):
            self.attempts += 1
            if self.attempts == 2:
                second_lock_attempted.set()
            self.lock.acquire()

        def __exit__(self, *args):
            self.lock.release()

    handler._inference_lock = ObservedLock()
    original_set_image = handler.predictor.set_image

    def set_image(image):
        original_set_image(image)
        if image[0, 0, 0] == 0:
            first_image_set.set()
            assert allow_first_prediction.wait(5)

    handler.predictor.set_image = set_image
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(handler.handle, Image.new('RGB', (6, 4), 'black'),
                            pos_points=[[1, 1]], neg_points=[], obj_bbox=None)
        assert first_image_set.wait(5)
        second = pool.submit(handler.handle_refine, Image.new('RGB', (6, 4), 'white'),
                             refinement_mask=[0, 4, 3, 1, 4, 2],
                             pos_points=[[3, 1]], neg_points=[])
        try:
            assert second_lock_attempted.wait(5)
            assert not second.done()
        finally:
            allow_first_prediction.set()
        first.result(timeout=5)
        second.result(timeout=5)
    assert [int(image[0, 0, 0]) for image, _ in handler.predictor.requests] == [0, 255]


@pytest.mark.parametrize('mode', ['text', 'visual', 'refine'])
def test_inference_enters_a_fresh_autocast_context_on_request_threads(mode):
    torch = pytest.importorskip('torch')
    handler = make_refinement_handler()
    # Reproduce SAM3's bf16 activations + float32 Linear weights with native Torch
    # on CPU. Autocast is thread local and must cover each complete inference.
    layer = torch.nn.Linear(2, 2)
    activations = torch.ones((1, 2), dtype=torch.bfloat16)
    handler._autocast = lambda: torch.autocast(device_type='cpu', dtype=torch.bfloat16)
    checked = []

    def check_precision():
        checked.append(layer(activations).dtype)

    if mode == 'text':
        original_set_image = handler.processor.set_image
    else:
        original_set_image = handler.predictor.set_image

    def set_image(image):
        check_precision()
        return original_set_image(image)

    if mode == 'text':
        handler.processor.set_image = set_image
        call = lambda: handler.handle_text(Image.new('RGB', (6, 4)), text_prompt='cat')
    elif mode == 'visual':
        handler.predictor.set_image = set_image
        call = lambda: handler.handle(Image.new('RGB', (6, 4)), pos_points=[[1, 1]],
                                      neg_points=[], obj_bbox=None)
    else:
        handler.predictor.set_image = set_image
        call = lambda: handler.handle_refine(Image.new('RGB', (6, 4)),
                                             refinement_mask=[0, 4, 3, 1, 4, 2],
                                             pos_points=[[3, 1]], neg_points=[])

    def request():
        call()
        with pytest.raises(RuntimeError, match='dtype'):
            layer(activations)

    with ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(request).result(timeout=5)
        pool.submit(request).result(timeout=5)
    assert checked == [torch.bfloat16, torch.bfloat16]


@pytest.mark.parametrize(('positive', 'anchored_pixels', 'fallback_pixels', 'expected_pixels'), [
    (True, [], [(4, 1)], [(4, 1)]),
    (False, [(4, 1)], [], []),
    # A fallback which ignores the same click must not replace the anchored mask.
    (True, [(3, 1)], [(3, 2)], [(3, 1)]),
])
def test_refine_relaxes_extent_only_when_click_agreement_improves(
    positive, anchored_pixels, fallback_pixels, expected_pixels,
):
    pytest.importorskip('torch')
    handler = make_refinement_handler()
    requests = []

    def predict(**kwargs):
        requests.append(kwargs)
        pixels = anchored_pixels if kwargs['box'] is not None else fallback_pixels
        mask = np.zeros((4, 6), dtype=bool)
        for x, y in pixels:
            mask[y, x] = True
        return mask[None], np.array([0.75]), np.empty((1, 12, 16))

    handler.predictor.predict = predict
    shapes = handler.handle_refine(
        Image.new('RGB', (6, 4)), refinement_mask=[0, 4, 3, 1, 4, 2],
        pos_points=[[4, 1]] if positive else [],
        neg_points=[] if positive else [[4, 1]],
    )
    assert len(requests) == 2
    assert requests[0]['box'] is not None and requests[1]['box'] is None
    for key in ('mask_input', 'point_coords', 'point_labels'):
        np.testing.assert_array_equal(requests[0][key], requests[1][key])
    actual = decode_mask(shapes[0]['points'], (6, 4)) if shapes else np.zeros((4, 6), dtype=bool)
    expected = np.zeros((4, 6), dtype=bool)
    for x, y in expected_pixels:
        expected[y, x] = True
    np.testing.assert_array_equal(actual, expected)


def test_refine_keeps_anchored_prediction_without_fallback_when_clicks_agree():
    pytest.importorskip('torch')
    handler = make_refinement_handler()
    handler.handle_refine(
        Image.new('RGB', (6, 4)), refinement_mask=[0, 4, 3, 1, 4, 2],
        pos_points=[[4, 1]], neg_points=[[0, 0]],
    )
    assert len(handler.predictor.requests) == 1


def test_refine_checks_fractional_border_clicks_without_rounding_out_of_image():
    pytest.importorskip('torch')
    handler = make_refinement_handler()
    handler.predictor.mask[:] = True
    handler.handle_refine(
        Image.new('RGB', (6, 4)), refinement_mask=[0, 4, 3, 1, 4, 2],
        pos_points=[[5.99999999, 3.99999999]], neg_points=[],
    )
    assert len(handler.predictor.requests) == 1
