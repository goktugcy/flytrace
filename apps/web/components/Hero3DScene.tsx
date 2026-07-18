'use client';

import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { Suspense, useMemo, useRef } from 'react';
import {
  Box3,
  Color,
  type Group,
  type Material,
  type Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const ENGINE_MODEL_URL = '/models/airplane_engine.glb';

/**
 * Hero model via React Three Fiber, mounted only when WebGL is available (see
 * Hero). `animate=false` renders a still frame for reduced-motion viewers.
 */
export function Hero3DScene({ animate }: { animate: boolean }) {
  return (
    <Canvas
      camera={{ position: [0, 0.25, 4.35], fov: 40 }}
      style={{ width: '100%', height: '100%' }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
    >
      <ambientLight intensity={0.9} />
      <hemisphereLight args={['#d8f7ff', '#162236', 1.3]} />
      <directionalLight position={[3.5, 4, 4.5]} intensity={2.4} />
      <directionalLight position={[-4, -1, 2]} intensity={0.65} color="#4fd1c5" />
      <Suspense fallback={<EngineFallback animate={animate} />}>
        <AirplaneEngine />
      </Suspense>
    </Canvas>
  );
}

function AirplaneEngine() {
  const gltf = useLoader(GLTFLoader, ENGINE_MODEL_URL) as GLTF;
  const group = useRef<Group>(null);

  const { scene, scale } = useMemo(() => {
    const clonedScene = gltf.scene.clone(true);
    const bounds = new Box3().setFromObject(clonedScene);
    const size = new Vector3();
    const center = new Vector3();

    bounds.getSize(size);
    bounds.getCenter(center);
    clonedScene.position.set(-center.x, -center.y, -center.z);
    colorizeEngine(clonedScene);

    const maxAxis = Math.max(size.x, size.y, size.z);
    return {
      scene: clonedScene,
      scale: maxAxis > 0 ? 2.45 / maxAxis : 1,
    };
  }, [gltf.scene]);

  return (
    <group ref={group} position={[0, -0.05, 0]} rotation={[0.18, -0.5, -0.08]} scale={scale}>
      <primitive object={scene} dispose={null} />
    </group>
  );
}

function isMesh(object: unknown): object is Mesh {
  return object !== null && typeof object === 'object' && (object as Mesh).isMesh === true;
}

function colorizeEngine(scene: Group) {
  let meshIndex = 0;
  const accents = [
    new Color('#4fd1c5'),
    new Color('#7dd3fc'),
    new Color('#f59e0b'),
    new Color('#ef4444'),
  ];

  scene.traverse((object) => {
    if (!isMesh(object)) return;

    object.castShadow = true;
    object.receiveShadow = true;

    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
    const nextMaterials = sourceMaterials.map((material, materialIndex) => {
      const nextMaterial = material.clone() as Material;

      if (nextMaterial instanceof MeshStandardMaterial) {
        const isAccent = meshIndex % 11 === 0 || meshIndex % 17 === 0;
        const isWarmAccent = meshIndex % 29 === 0;

        nextMaterial.color = isAccent
          ? accents[(meshIndex + materialIndex) % accents.length]
          : new Color(meshIndex % 3 === 0 ? '#d5dde8' : '#748195');
        nextMaterial.emissive = isWarmAccent ? new Color('#f59e0b') : new Color('#0b1f32');
        nextMaterial.emissiveIntensity = isWarmAccent ? 0.22 : 0.04;
        nextMaterial.metalness = isAccent ? 0.72 : 0.88;
        nextMaterial.roughness = isAccent ? 0.32 : 0.42;
      }

      return nextMaterial;
    });

    object.material = Array.isArray(object.material) ? nextMaterials : nextMaterials[0];
    meshIndex += 1;
  });
}

function EngineFallback({ animate }: { animate: boolean }) {
  const group = useRef<Group>(null);

  useFrame((_, delta) => {
    if (animate && group.current) group.current.rotation.y += delta * 0.25;
  });

  return (
    <group ref={group} rotation={[0.18, -0.5, -0.08]}>
      <mesh>
        <cylinderGeometry args={[0.78, 0.95, 1.35, 48, 1, true]} />
        <meshStandardMaterial color="#23344f" roughness={0.62} metalness={0.38} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.72, 0.035, 16, 64]} />
        <meshStandardMaterial color="#4fd1c5" roughness={0.35} metalness={0.7} />
      </mesh>
    </group>
  );
}
