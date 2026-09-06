FROM quay.io/nuclio/handler-builder-python-onbuild:1.16.3-amd64@sha256:57274875b88d261a3525d70f7fc6052f5a98f867ded720444864e2cf4b2714fe AS processor
FROM quay.io/nuclio/uhttpc:0.0.1-amd64@sha256:ff2ac8fdeb047c842c4d895c0cf904095424af030fd2603cec01ad9968d3d386 AS uhttpc
FROM pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime@sha256:417bd75df6365104c283ea4c1651fb3530d9eb5a4c2fafa51943cff2a94e6385 AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=processor /home/nuclio/bin/processor /usr/local/bin/processor
COPY --from=processor /home/nuclio/bin/py /opt/nuclio/
COPY --from=processor /home/nuclio/bin/py3.11-whl /opt/nuclio/whl/
COPY --from=uhttpc /home/nuclio/bin/uhttpc /usr/local/bin/uhttpc
RUN python -m pip install --no-index --find-links /opt/nuclio/whl nuclio-sdk msgpack
COPY requirements.txt /opt/nuclio/requirements.txt
RUN python -m pip install --no-cache-dir -r /opt/nuclio/requirements.txt \
    # Roboflow pins an older headless wheel. Supervision also installs the GUI
    # wheel; make the effective cv2 implementation match the bridge environment.
    && python -m pip install --no-cache-dir --no-deps --force-reinstall opencv-python==4.13.0.92 \
    && python -m pip check
COPY vendor /opt/indoor/vendor/
ENV PYTHONPATH=/opt/nuclio:/opt/indoor/vendor/rf-detr/src:/opt/indoor/vendor/training-toolkit/src \
    CHECKPOINT_PATH=/opt/models/epoch=022-map=0.0805.ckpt \
    HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 \
    NO_ALBUMENTATIONS_UPDATE=1 OMP_NUM_THREADS=4
WORKDIR /opt/nuclio
RUN python -c "import cv2, torch; from training_toolkit.models.rfdetr import RFDETRAdapter; from rfdetr.models.lwdetr import PostProcess; assert cv2.__version__ == '4.13.0'; assert torch.__version__.startswith('2.8.0')"

FROM runtime AS function
COPY main.py model_handler.py geometry.py model-metadata.json /opt/nuclio/
HEALTHCHECK --interval=10s --timeout=3s --start-period=180s CMD /usr/local/bin/uhttpc --url http://127.0.0.1:8082/ready
CMD ["processor"]
