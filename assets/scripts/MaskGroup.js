this.traverse((child)=>{
    if (child.material) {
        child.material.colorWrite = false;
        child.renderOrder = -1;
    }
});